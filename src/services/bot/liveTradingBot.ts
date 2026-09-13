import { EventEmitter } from 'events'
import {
  appendTradingLog,
  computeAISignal,
  checkDrawdownExceeded,
  toExecutionSignal,
  shouldExecuteTrade,
  executeTrade,
  fetchUserClosedTradeStats,
  EXEC_MIN_COOLDOWN_MS,
  RISK,
  type ExecutionContext,
} from '@cryptoflow/bot'
import { prisma, OrderSide, OrderType, ExecutionEventType } from '@cryptoflow/db'
import { placeOrder } from '../orders/orderService'
import { decryptSecret } from '../../lib/crypto'
import { binanceAdapter } from '../exchange/binanceAdapter'
import { evaluateTradeIntent } from '../signals/tradeAdvisor'
import { getCexExitSettings } from '../exchange/cexExitSettingsService'

interface LiveBotInstance {
  userId: string
  strategyId: string
  pair: string
  symbol: string
  exchangeConnectionId: string
  orderSizeUsdt: number
  interval: NodeJS.Timeout
  position: 'NONE' | 'LONG'
  baseQtyHeld: number
  entryPrice: number | null
  lastExecutionAt: number | null
  sessionPeakEquity: number
  drawdownHalted: boolean
}

const LIVE_ENGINE_AUTOMATION_INTERVAL_MS = 5_000
const LIVE_MAX_SESSION_DRAWDOWN_PCT = 0.15

type TradeExecutedPayload = {
  userId: string
  trade: {
    id: string
    pair: string
    signal: 'BUY' | 'SELL'
    price: number
    entryPrice?: number
    exitPrice?: number
    pnl?: number
    status: 'OPEN' | 'CLOSED'
    mode: 'LIVE'
  }
  currentPnl: number
}

async function fetchPrice(symbol: string): Promise<number | null> {
  try {
    const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`)
    const data = (await response.json()) as { price?: string }
    if (!data.price) return null
    return parseFloat(data.price)
  } catch {
    return null
  }
}

function formatBaseQty(qty: number): string {
  const s = qty.toFixed(8).replace(/\.?0+$/, '')
  return s === '' ? '0' : s
}

/**
 * Live spot bot: AI-assisted signals (RSI/trend/vol/volume); orders via OMS when enabled.
 */
class LiveTradingBot extends EventEmitter {
  private bots: Map<string, LiveBotInstance> = new Map()

  isRunning(userId: string): boolean {
    return this.bots.has(userId)
  }

  async start(
    userId: string,
    strategyId: string,
    pair: string,
    exchangeConnectionId: string,
    orderSizeUsdt: number
  ): Promise<void> {
    if (this.bots.has(userId)) {
      throw new Error('Bot already running for this user')
    }

    const symbol = pair.replace('/', '')
    const portfolio = await prisma.portfolio.findUnique({ where: { userId } })
    const peak = Number(portfolio?.totalValue ?? 0)
    const bot: LiveBotInstance = {
      userId,
      strategyId,
      pair,
      symbol,
      exchangeConnectionId,
      orderSizeUsdt,
      interval: null as unknown as NodeJS.Timeout,
      position: 'NONE',
      baseQtyHeld: 0,
      entryPrice: null,
      lastExecutionAt: null,
      sessionPeakEquity: peak,
      drawdownHalted: false,
    }

    bot.interval = setInterval(() => {
      this.tick(bot).catch((error) => {
        console.error(`Live bot error for user ${userId}:`, error)
      })
    }, LIVE_ENGINE_AUTOMATION_INTERVAL_MS)

    this.bots.set(userId, bot)
    await this.runLiveStartupProbe(bot)
    this.tick(bot).catch(console.error)
    console.warn(
      `Live bot started for user ${userId} on ${pair} (${orderSizeUsdt} USDT per entry, auto tick ${LIVE_ENGINE_AUTOMATION_INTERVAL_MS}ms)`
    )
    this.emit('bot:started', { userId, pair, orderSizeUsdt })
  }

  /**
   * Minimal market buy→sell at start so the user sees real fills immediately (not AI-gated).
   * Uses a small USDT quote (5) when execution is enabled; logs only when disabled.
   */
  private async runLiveStartupProbe(bot: LiveBotInstance): Promise<void> {
    const price = await fetchPrice(bot.symbol)
    if (price === null) {
      await appendTradingLog(bot.userId, 'SYSTEM', '[live startup] No price — exchange probe skipped')
      return
    }
    const probeQuote = Math.min(bot.orderSizeUsdt, 5)
    if (probeQuote < 1) {
      await appendTradingLog(
        bot.userId,
        'SYSTEM',
        '[live startup] Order size under 1 USDT — skipping exchange smoke order',
        { orderSizeUsdt: bot.orderSizeUsdt }
      )
      return
    }
    const saved = bot.orderSizeUsdt
    try {
      bot.orderSizeUsdt = probeQuote
      await this.openLong(bot, price)
      if (bot.position === 'LONG' && bot.baseQtyHeld > 0) {
        await appendTradingLog(bot.userId, 'EXEC', `[live startup] Smoke BUY 5 USDT ${bot.symbol} OK`, { probe: true })
        await this.closePosition(bot, price)
        await appendTradingLog(bot.userId, 'EXEC', `[live startup] Smoke SELL ${bot.symbol} — engine OK`, { probe: true })
      }
    } catch (e) {
      await appendTradingLog(bot.userId, 'SYSTEM', `[live startup] Exchange probe failed: ${String(e)}`, { probe: true })
    } finally {
      bot.orderSizeUsdt = saved
    }
  }

  async stop(userId: string): Promise<{ sessionDuration: number; totalTrades: number }> {
    const bot = this.bots.get(userId)
    if (!bot) {
      throw new Error('No active live bot for this user')
    }

    clearInterval(bot.interval)

    if (bot.position === 'LONG' && bot.baseQtyHeld > 0) {
      const price = await fetchPrice(bot.symbol)
      if (price !== null) {
        await this.closePosition(bot, price)
      }
    }

    const session = await prisma.botSession.findFirst({
      where: { userId, isActive: true },
    })

    const sessionDuration = session
      ? Math.floor((Date.now() - session.startedAt.getTime()) / 1000)
      : 0

    const totalTrades = await prisma.order.count({
      where: {
        userId,
        createdAt: { gte: session?.startedAt ?? new Date(0) },
      },
    })

    this.bots.delete(userId)
    this.emit('bot:stopped', { userId, sessionDuration, totalTrades })
    return { sessionDuration, totalTrades }
  }

  private firstTickDone = new Set<string>()

  private async fetchBinanceUsdtBalance(bot: LiveBotInstance): Promise<number | null> {
    try {
      const conn = await prisma.exchangeConnection.findFirst({
        where: { id: bot.exchangeConnectionId, isActive: true },
      })
      if (!conn) return null
      const balances = await binanceAdapter.getBalances(
        decryptSecret(conn.encryptedApiKey),
        decryptSecret(conn.encryptedSecret),
      )
      const usdt = balances.find((b) => b.asset === 'USDT')
      return usdt ? Number(usdt.free) : 0
    } catch {
      return null
    }
  }

  private async tick(bot: LiveBotInstance): Promise<void> {
    const price = await fetchPrice(bot.symbol)
    if (price === null) return

    // Hard TP / SL on open CEX lots (order-book mark) — independent of AI SELL signals.
    if (bot.position === 'LONG' && bot.entryPrice != null && bot.baseQtyHeld > 0) {
      const exitPrefs = await getCexExitSettings(bot.userId)
      if (exitPrefs.enabled) {
        const entry = bot.entryPrice
        const pnlPct = ((price - entry) / entry) * 100
        if (pnlPct >= exitPrefs.takeProfitPct) {
          await appendTradingLog(
            bot.userId,
            'EXEC',
            `[live] Take-profit ${pnlPct.toFixed(2)}% ≥ ${exitPrefs.takeProfitPct}% — closing ${bot.pair}`,
            { source: 'binance-cex', reason: 'take_profit', pnlPct, mark: price, entry },
          )
          await this.closePosition(bot, price)
          return
        }
        if (pnlPct <= -exitPrefs.stopLossPct) {
          await appendTradingLog(
            bot.userId,
            'EXEC',
            `[live] Stop-loss ${pnlPct.toFixed(2)}% ≤ -${exitPrefs.stopLossPct}% — closing ${bot.pair}`,
            { source: 'binance-cex', reason: 'stop_loss', pnlPct, mark: price, entry },
          )
          await this.closePosition(bot, price)
          return
        }
      }
    }

    if (!this.firstTickDone.has(bot.userId) && bot.position === 'NONE') {
      this.firstTickDone.add(bot.userId)
      const realBal = await this.fetchBinanceUsdtBalance(bot)
      if (realBal !== null && realBal > 0) {
        const safeSize = Math.floor(Math.min(realBal * 0.9, bot.orderSizeUsdt) * 100) / 100
        if (safeSize >= 1) {
          const advisory = await evaluateTradeIntent({
            userId: bot.userId,
            symbol: bot.symbol,
            side: 'BUY',
            sizeUsdt: safeSize,
            accountEquityUsdt: realBal,
          }).catch(() => null)
          if (advisory && !advisory.allow) {
            await appendTradingLog(
              bot.userId,
              'FILTER',
              `[live] First BUY blocked by signal advisor (${advisory.symbol}): ${advisory.reasons
                .filter((r) => r.severity === 'block')
                .map((r) => r.message)
                .join('; ')}`,
              {
                advisorReasons: advisory.reasons,
                projectedWorstCaseLossUsdt: advisory.projectedWorstCaseLossUsdt,
                consensus: advisory.snapshot.consensus,
              },
            )
            return
          }
          const finalSize =
            advisory && advisory.recommendedSizeUsdt > 0
              ? Math.min(safeSize, advisory.recommendedSizeUsdt)
              : safeSize
          const saved = bot.orderSizeUsdt
          bot.orderSizeUsdt = Math.max(1, Math.floor(finalSize * 100) / 100)
          await appendTradingLog(
            bot.userId,
            'EXEC',
            `[live] Force opening first position at ${price} (${bot.orderSizeUsdt} USDT)` +
              (advisory ? ` advisor=${advisory.decision}` : ''),
            { probe: false, realBalance: realBal, advisor: advisory?.decision ?? null },
          )
          try {
            await this.openLong(bot, price)
            return
          } catch (e) {
            await appendTradingLog(bot.userId, 'SYSTEM', `[live] Force first BUY failed: ${String(e)}`)
          } finally {
            bot.orderSizeUsdt = saved
          }
        } else {
          await appendTradingLog(bot.userId, 'SYSTEM', `[live] Binance USDT balance too low for first trade (${realBal} USDT)`)
        }
      }
    }

    const ai = await computeAISignal(bot.symbol)
    if (!ai) return

    await appendTradingLog(bot.userId, 'SIGNAL', `[live] ${ai.action} conf=${ai.confidence.toFixed(3)}`, {
      ...ai.features,
      price,
    })

    const portfolio = await prisma.portfolio.findUnique({ where: { userId: bot.userId } })
    const capitalUsd = Math.max(Number(portfolio?.totalValue ?? 0), bot.orderSizeUsdt, 1e-9)
    const currentEquity = Number(portfolio?.totalValue ?? 0)
    bot.sessionPeakEquity = Math.max(bot.sessionPeakEquity, currentEquity)
    const peak = Math.max(bot.sessionPeakEquity, 1e-9)
    const sessionDrawdownPct = (peak - currentEquity) / peak
    if (sessionDrawdownPct >= LIVE_MAX_SESSION_DRAWDOWN_PCT) {
      await appendTradingLog(
        bot.userId,
        'RISK',
        `[live] Capital protection stop: session drawdown ${(
          sessionDrawdownPct * 100
        ).toFixed(2)}% exceeded ${(LIVE_MAX_SESSION_DRAWDOWN_PCT * 100).toFixed(0)}% threshold`
      )
      if (bot.position === 'LONG' && bot.baseQtyHeld > 0) {
        await this.closePosition(bot, price)
      }
      await this.emergencyStop(bot, 'risk_drawdown_halt')
      return
    }
    if (checkDrawdownExceeded(currentEquity, bot.sessionPeakEquity)) {
      if (!bot.drawdownHalted) {
        bot.drawdownHalted = true
        await appendTradingLog(bot.userId, 'RISK', '[live] Drawdown >= 10% — new entries halted')
      }
    }

    const stats = await fetchUserClosedTradeStats(bot.userId)
    const openCount = bot.position === 'LONG' ? 1 : 0
    const proposedTradeFraction = Math.min(RISK.MAX_CAPITAL_PER_TRADE, bot.orderSizeUsdt / capitalUsd)
    const openExposureFraction = bot.position === 'LONG' ? proposedTradeFraction : 0

    const execSignal = toExecutionSignal(bot.symbol, price, ai)
    const ctx: ExecutionContext = {
      mode: 'cex',
      userId: bot.userId,
      pair: bot.pair,
      capitalUsd,
      proposedNotionalUsd: bot.orderSizeUsdt,
      proposedTradeFraction,
      openPositionCount: openCount,
      openExposureFraction,
      hasOpenPositionOnPair: bot.position === 'LONG',
      volatilityPct: ai.features.volatilityPct,
      drawdownHalted: bot.drawdownHalted,
      sessionPeakEquity: bot.sessionPeakEquity,
      currentEquity,
      closedTrades: stats.closedTrades,
      losingTrades: stats.losingTrades,
      winningTrades: stats.winningTrades,
      minCooldownMs: EXEC_MIN_COOLDOWN_MS,
      lastTradeAt: bot.lastExecutionAt,
      estimatedGasUsd: 0,
      bid: price,
      ask: price,
    }

    const decision = shouldExecuteTrade(execSignal, ctx)
    if (!decision.approved && ai.action !== 'HOLD') {
      await appendTradingLog(bot.userId, 'FILTER', `[live] Blocked: ${decision.reason}`, {
        action: ai.action,
        confidence: ai.confidence,
      })
    }
    if (!decision.approved) return

    if (ai.action === 'BUY' && bot.position === 'NONE') {
      const advisory = await evaluateTradeIntent({
        userId: bot.userId,
        symbol: bot.symbol,
        side: 'BUY',
        sizeUsdt: bot.orderSizeUsdt,
        accountEquityUsdt: capitalUsd,
      }).catch(() => null)
      if (advisory && !advisory.allow) {
        await appendTradingLog(
          bot.userId,
          'FILTER',
          `[live] Buy blocked by signal advisor: ${advisory.reasons
            .filter((r) => r.severity === 'block')
            .map((r) => `${r.message} (source: ${r.source})`)
            .join(' | ')}`,
          {
            advisorDecision: advisory.decision,
            advisorReasons: advisory.reasons,
            projectedWorstCaseLossUsdt: advisory.projectedWorstCaseLossUsdt,
            consensus: advisory.snapshot.consensus,
          },
        )
        this.emit('advisor:blocked', {
          userId: bot.userId,
          symbol: bot.symbol,
          side: 'BUY' as const,
          reasons: advisory.reasons,
        })
        return
      }
      if (advisory && advisory.decision === 'caution') {
        const reduced = Math.max(1, Math.floor(advisory.recommendedSizeUsdt * 100) / 100)
        if (reduced > 0 && reduced < bot.orderSizeUsdt) {
          await appendTradingLog(
            bot.userId,
            'RISK',
            `[live] Advisor caution — reducing size from ${bot.orderSizeUsdt} to ${reduced} USDT`,
            {
              advisorReasons: advisory.reasons,
              projectedWorstCaseLossUsdt: advisory.projectedWorstCaseLossUsdt,
            },
          )
          bot.orderSizeUsdt = reduced
        }
      }
    }

    await executeTrade(decision, {
      buy: async () => {
        await this.openLong(bot, price)
      },
      sell: async () => {
        await this.closePosition(bot, price)
      },
    })
  }

  private async emergencyStop(bot: LiveBotInstance, reason: string): Promise<void> {
    clearInterval(bot.interval)
    this.bots.delete(bot.userId)
    this.firstTickDone.delete(bot.userId)
    this.emit('bot:emergency_stop', { userId: bot.userId, reason })
    try {
      const now = new Date()
      await prisma.botSession.updateMany({
        where: { userId: bot.userId, isActive: true },
        data: { isActive: false, stoppedAt: now },
      })
      const run = await prisma.botRun.findFirst({
        where: { userId: bot.userId, status: 'RUNNING' },
        orderBy: { startedAt: 'desc' },
      })
      if (run) {
        await prisma.botRun.update({
          where: { id: run.id },
          data: { status: 'STOPPED', stoppedAt: now, stopReason: reason },
        })
        await prisma.executionEvent.create({
          data: {
            userId: bot.userId,
            botRunId: run.id,
            eventType: ExecutionEventType.BOT_STOPPED,
            payload: { reason, source: 'live_capital_protection' },
          },
        })
      }
    } catch {
      // best-effort emergency stop persistence
    }
  }

  private async openLong(bot: LiveBotInstance, price: number): Promise<void> {
    const quoteQty = Math.floor(bot.orderSizeUsdt * 100) / 100
    if (quoteQty < 1) {
      const err = { type: 'VALIDATION_ERROR' as const, reason: 'MIN_SIZE', message: `Order size $${quoteQty} too small — minimum $1 USDT` }
      await appendTradingLog(bot.userId, 'trade.validation.failed', err.message, err)
      this.emit('trade:failed', { userId: bot.userId, error: err })
      return
    }

    await appendTradingLog(bot.userId, 'trade.attempt', `BUY ${bot.symbol} $${quoteQty} USDT @ ${price}`, {
      symbol: bot.symbol, side: 'BUY', quoteQty, price,
    })

    let filled: any
    try {
      filled = await placeOrder({
        userId: bot.userId,
        exchangeConnectionId: bot.exchangeConnectionId,
        symbol: bot.symbol,
        side: OrderSide.BUY,
        type: OrderType.MARKET,
        quantity: quoteQty,
        quoteOrderQty: quoteQty,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await appendTradingLog(bot.userId, 'trade.execution.failed', msg)
      this.emit('trade:failed', { userId: bot.userId, error: { type: 'BINANCE_ERROR', message: msg } })
      return
    }

    const qty = Number(filled.filledQuantity ?? 0)
    if (qty <= 0) {
      await appendTradingLog(bot.userId, 'trade.execution.failed', 'No fill quantity returned from Binance')
      return
    }

    await appendTradingLog(bot.userId, 'trade.execution.success',
      `BUY FILLED ${bot.symbol}: ${qty} @ $${(quoteQty / qty).toFixed(2)}`,
      { orderId: filled.id, filledQty: qty, quoteQty },
    )

    bot.position = 'LONG'
    bot.baseQtyHeld = qty
    bot.entryPrice = price

    const portfolio = await prisma.portfolio.findUnique({
      where: { userId: bot.userId },
      select: { pnl: true },
    })

    const payload: TradeExecutedPayload = {
      userId: bot.userId,
      trade: {
        id: filled.id,
        pair: bot.pair,
        signal: 'BUY',
        price,
        entryPrice: price,
        status: 'OPEN',
        mode: 'LIVE',
      },
      currentPnl: Number(portfolio?.pnl ?? 0),
    }
    this.emit('trade:executed', payload)
    bot.lastExecutionAt = Date.now()
    await appendTradingLog(bot.userId, 'EXEC', `[live] BUY ${bot.pair} (${bot.symbol}) filled`, {
      tradeSide: 'BUY',
      venue: 'BINANCE_SPOT',
      pair: bot.pair,
      symbol: bot.symbol,
      orderId: filled.id,
      filledBaseQty: qty,
      filledQuoteUsdt: filled.quoteQuantity != null ? Number(filled.quoteQuantity) : undefined,
      avgFillPrice: filled.avgFillPrice != null ? Number(filled.avgFillPrice) : undefined,
      refPrice: price,
      executedAt: new Date().toISOString(),
      chainGasUsd: null,
      chainGasNote: 'CEX spot: no L1 gas. Binance trading fees apply on fills.',
    })
  }

  private async closePosition(bot: LiveBotInstance, price: number): Promise<void> {
    if (bot.baseQtyHeld <= 0 || bot.entryPrice === null) return

    await appendTradingLog(bot.userId, 'trade.attempt', `SELL ${bot.symbol} qty=${bot.baseQtyHeld} @ ${price}`, {
      symbol: bot.symbol, side: 'SELL', baseQty: bot.baseQtyHeld, price,
    })

    let filled: any
    try {
      filled = await placeOrder({
        userId: bot.userId,
        exchangeConnectionId: bot.exchangeConnectionId,
        symbol: bot.symbol,
        side: OrderSide.SELL,
        type: OrderType.MARKET,
        quantity: Number(formatBaseQty(bot.baseQtyHeld)),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await appendTradingLog(bot.userId, 'trade.execution.failed', msg)
      this.emit('trade:failed', { userId: bot.userId, error: { type: 'BINANCE_ERROR', message: msg } })
      return
    }

    const soldQty = Number(filled.filledQuantity ?? bot.baseQtyHeld)

    await appendTradingLog(bot.userId, 'trade.execution.success',
      `SELL FILLED ${bot.symbol}: ${soldQty}`,
      { orderId: filled.id, filledQty: soldQty },
    )
    const exitPx = price
    const pnl = (exitPx - bot.entryPrice) * soldQty

    await prisma.portfolio.update({
      where: { userId: bot.userId },
      data: {
        pnl: { increment: pnl },
        totalValue: { increment: pnl },
      },
    })

    const portfolio = await prisma.portfolio.findUnique({
      where: { userId: bot.userId },
      select: { pnl: true },
    })

    const payload: TradeExecutedPayload = {
      userId: bot.userId,
      trade: {
        id: filled.id,
        pair: bot.pair,
        signal: 'SELL',
        price: exitPx,
        entryPrice: bot.entryPrice,
        exitPrice: exitPx,
        pnl,
        status: 'CLOSED',
        mode: 'LIVE',
      },
      currentPnl: Number(portfolio?.pnl ?? 0),
    }
    this.emit('trade:executed', payload)

    await appendTradingLog(bot.userId, 'EXEC', `[live] SELL ${bot.pair} (${bot.symbol}) filled`, {
      tradeSide: 'SELL',
      venue: 'BINANCE_SPOT',
      pair: bot.pair,
      symbol: bot.symbol,
      orderId: filled.id,
      soldBaseQty: soldQty,
      pnl,
      refPrice: exitPx,
      executedAt: new Date().toISOString(),
      chainGasUsd: null,
      chainGasNote: 'CEX spot: no L1 gas. Binance trading fees apply on fills.',
    })

    bot.position = 'NONE'
    bot.baseQtyHeld = 0
    bot.entryPrice = null
    bot.lastExecutionAt = Date.now()
  }
}

export const liveTradingBot = new LiveTradingBot()
