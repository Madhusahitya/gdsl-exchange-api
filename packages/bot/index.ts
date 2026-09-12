import { EventEmitter } from 'events'
import { prisma } from '@cryptoflow/db'
import { computeAISignal, type AISignalResult } from './signalEngine'
import { RISK, checkDrawdownExceeded, countOpenPaperPositions } from './risk'
import {
  toExecutionSignal,
  shouldExecuteTrade,
  executeTrade,
  fetchUserClosedTradeStats,
  EXEC_MIN_COOLDOWN_MS,
  type ExecutionContext,
} from './executionEngine'
import { fetchBookTicker } from './marketData'
import { paperClosePosition, paperOpenPosition } from './paperExecution'
import { paperExecutionSellPrice } from './paperRealism'
import { appendTradingLog } from './tradingLog'
/* PAPER_STARTING_USD intentionally not imported here — real-funds-only mode. */

interface BotInstance {
  userId: string
  strategyId: string
  pairs: string[]
  pair: string
  symbol: string
  interval: NodeJS.Timeout
  tradeSizePct: number
  sessionPeakEquity: number
  drawdownHalted: boolean
  /** Anti-churn: last time we opened or closed (ms). */
  lastExecutionAt: number | null
}

interface TradeExecutedPayload {
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
    confidence?: number
  }
  currentPnl: number
}

const lastSignalByUser = new Map<
  string,
  {
    action: AISignalResult['action']
    confidence: number
    minConfidenceRequired: number
    features: AISignalResult['features']
    updatedAt: string
  }
>()

export function getLastEngineSignal(userId: string) {
  return lastSignalByUser.get(userId) ?? null
}

/** Immediate round-trip on start: confirms book + DB + execution path (bypasses AI gate). */
const STARTUP_PROBE_MIN_USD = 5
const STARTUP_PROBE_MAX_USD = 25

class PaperTradingBot extends EventEmitter {
  private bots: Map<string, BotInstance> = new Map()

  async start(
    userId: string,
    strategyId: string,
    pair: string,
    opts?: { tradeSizePct?: number; pairs?: string[] }
  ): Promise<void> {
    if (this.bots.has(userId)) {
      throw new Error('Bot already running for this user')
    }

    // Real-funds-only: never auto-credit phantom capital. Portfolio.totalValue
    // is reconciled from the deposit/withdraw/PnL ledger. Sizing decisions in
    // this legacy code path therefore use the true equity and refuse to size
    // when the account is empty.
    let portfolio = await prisma.portfolio.findUnique({ where: { userId } })
    if (!portfolio) {
      portfolio = await prisma.portfolio.create({
        data: { userId, totalValue: 0, pnl: 0 },
      })
    }

    const peak = Number(portfolio.totalValue) + Number(portfolio.pnl)

    const tradeSizePct = Math.min(100, Math.max(10, opts?.tradeSizePct ?? 50))

    const pairs = Array.from(new Set((opts?.pairs && opts.pairs.length > 0 ? opts.pairs : [pair]).filter(Boolean)))
    const primaryPair = pairs[0] ?? pair
    const bot: BotInstance = {
      userId,
      strategyId,
      pairs,
      pair: primaryPair,
      symbol: primaryPair.replace('/', ''),
      interval: null as unknown as NodeJS.Timeout,
      tradeSizePct,
      sessionPeakEquity: peak,
      drawdownHalted: false,
      lastExecutionAt: null,
    }

    bot.interval = setInterval(() => {
      this.tick(bot).catch((error) => {
        console.error(`Bot error for user ${userId}:`, error)
      })
    }, 5_000)

    this.bots.set(userId, bot)
    await appendTradingLog(
      userId,
      'SYSTEM',
      `Paper bot started on ${pairs.join(', ')} (AI size ${tradeSizePct}%)`
    )
    await this.runStartupProbe(bot).catch((err) => {
      console.error(`Startup probe failed for ${userId}:`, err)
      void appendTradingLog(bot.userId, 'SYSTEM', `Startup probe failed: ${String(err)}`)
    })
    this.tick(bot).catch(console.error)
    console.warn(
      `Bot started for user ${userId} with strategy ${strategyId} on ${pairs.join(', ')}`
    )
  }

  async stop(userId: string): Promise<{ sessionDuration: number; totalTrades: number }> {
    const bot = this.bots.get(userId)
    if (!bot) {
      throw new Error('No active bot for this user')
    }

    clearInterval(bot.interval)

    const openTrades = await prisma.trade.findMany({
      where: { userId, status: 'OPEN' },
      orderBy: { createdAt: 'asc' },
    })
    for (const t of openTrades) {
      const symbol = t.pair.replace('/', '')
      const book = await fetchBookTicker(symbol)
      if (!book) continue
      await paperClosePosition({ userId, tradeId: t.id, exitBid: book.bid })
    }

    const session = await prisma.botSession.findFirst({
      where: { userId, isActive: true },
    })

    const sessionDuration = session
      ? Math.floor((Date.now() - session.startedAt.getTime()) / 1000)
      : 0

    const totalTrades = await prisma.trade.count({
      where: {
        userId,
        createdAt: { gte: session?.startedAt ?? new Date(0) },
      },
    })

    this.bots.delete(userId)
    lastSignalByUser.delete(userId)
    await appendTradingLog(userId, 'SYSTEM', `Paper bot stopped (${totalTrades} trades in session)`)
    console.warn(`Bot stopped for user ${userId}`)

    return { sessionDuration, totalTrades }
  }

  isRunning(userId: string): boolean {
    return this.bots.has(userId)
  }

  getActiveUserIds(): string[] {
    return Array.from(this.bots.keys())
  }

  getTradeSizePct(userId: string): number | null {
    return this.bots.get(userId)?.tradeSizePct ?? null
  }

  /**
   * One tiny open→close at live bid/ask (fees + slip applied). Not gated by AI or execution engine.
   * Lets the user see an instant execution and confirms the engine is wired.
   */
  private async runStartupProbe(bot: BotInstance): Promise<void> {
    const book = await fetchBookTicker(bot.symbol)
    if (book === null) {
      await appendTradingLog(bot.userId, 'SYSTEM', 'Startup probe skipped: no order book')
      return
    }
    const portfolio = await prisma.portfolio.findUnique({ where: { userId: bot.userId } })
    const total = Number(portfolio?.totalValue ?? 0)
    const probeUsd = Math.max(STARTUP_PROBE_MIN_USD, Math.min(STARTUP_PROBE_MAX_USD, total * 0.02))
    if (!Number.isFinite(total) || total < probeUsd + 1) {
      await appendTradingLog(
        bot.userId,
        'SYSTEM',
        `Startup probe skipped: need at least ~$${(probeUsd + 1).toFixed(0)} book (have $${total.toFixed(2)})`
      )
      return
    }

    const { bid, ask } = book
    const created = await paperOpenPosition({
      userId: bot.userId,
      strategyId: bot.strategyId,
      pair: bot.pair,
      entryAsk: ask,
      allocationUsd: probeUsd,
    })
    bot.lastExecutionAt = Date.now()

    let portfolio2 = await prisma.portfolio.findUnique({
      where: { userId: bot.userId },
      select: { pnl: true },
    })
    this.emit('trade:executed', {
      userId: bot.userId,
      trade: {
        id: created.id,
        pair: bot.pair,
        signal: 'BUY',
        price: created.executionPrice,
        entryPrice: created.executionPrice,
        status: 'OPEN',
        confidence: 1,
      },
      currentPnl: Number(portfolio2?.pnl ?? 0),
    } satisfies TradeExecutedPayload)

    const pnl = await paperClosePosition({
      userId: bot.userId,
      tradeId: created.id,
      exitBid: bid,
    })
    bot.lastExecutionAt = Date.now()

    portfolio2 = await prisma.portfolio.findUnique({
      where: { userId: bot.userId },
      select: { pnl: true },
    })
    const exitExec = paperExecutionSellPrice(bid)
    this.emit('trade:executed', {
      userId: bot.userId,
      trade: {
        id: created.id,
        pair: bot.pair,
        signal: 'SELL',
        price: exitExec,
        entryPrice: created.executionPrice,
        exitPrice: exitExec,
        pnl: pnl ?? undefined,
        status: 'CLOSED',
        confidence: 1,
      },
      currentPnl: Number(portfolio2?.pnl ?? 0),
    } satisfies TradeExecutedPayload)

    await appendTradingLog(bot.userId, 'SYSTEM', 'Startup probe round-trip complete (see EXEC lines above)', {
      probe: true,
      pnl,
    })
  }

  private async tick(bot: BotInstance): Promise<void> {
    for (const pair of bot.pairs) {
      await this.tickPair(bot, pair)
    }
  }

  private async tickPair(bot: BotInstance, pair: string): Promise<void> {
    const symbol = pair.replace('/', '')
    const signal = await computeAISignal(symbol)
    const book = await fetchBookTicker(symbol)
    if (book === null) return
    const { bid, ask, mid } = book

    if (signal) {
      lastSignalByUser.set(bot.userId, {
        action: signal.action,
        confidence: signal.confidence,
        minConfidenceRequired: signal.minConfidenceRequired,
        features: signal.features,
        updatedAt: new Date().toISOString(),
      })
      await appendTradingLog(bot.userId, 'SIGNAL', `${pair} ${signal.action} conf=${signal.confidence.toFixed(3)}`, {
        ...signal.features,
        pair,
        symbol,
        mid,
        bid,
        ask,
      })
    }

    const portfolio = await prisma.portfolio.findUnique({ where: { userId: bot.userId } })
    if (!portfolio) return

    const totalValue = Number(portfolio.totalValue)
    const currentEquity = totalValue

    bot.sessionPeakEquity = Math.max(bot.sessionPeakEquity, currentEquity)
    if (checkDrawdownExceeded(currentEquity, bot.sessionPeakEquity)) {
      if (!bot.drawdownHalted) {
        bot.drawdownHalted = true
        await appendTradingLog(bot.userId, 'RISK', 'Drawdown >= 10% — new entries halted')
      }
    }

    if (!signal) return

    const proposedFraction = RISK.MAX_CAPITAL_PER_TRADE * (bot.tradeSizePct / 100)
    const openCount = await countOpenPaperPositions(bot.userId)
    const openExposureFraction = openCount * proposedFraction

    const openForPair = await prisma.trade.findMany({
      where: { userId: bot.userId, pair, status: 'OPEN' },
      orderBy: { createdAt: 'asc' },
    })

    const stats = await fetchUserClosedTradeStats(bot.userId)
    const execSignal = toExecutionSignal(bot.symbol, mid, signal)

    const ctx: ExecutionContext = {
      mode: 'paper',
      userId: bot.userId,
      pair,
      capitalUsd: totalValue,
      proposedNotionalUsd: totalValue * proposedFraction,
      proposedTradeFraction: proposedFraction,
      openPositionCount: openCount,
      openExposureFraction,
      hasOpenPositionOnPair: openForPair.length > 0,
      volatilityPct: signal.features.volatilityPct,
      drawdownHalted: bot.drawdownHalted,
      sessionPeakEquity: bot.sessionPeakEquity,
      currentEquity,
      closedTrades: stats.closedTrades,
      losingTrades: stats.losingTrades,
      winningTrades: stats.winningTrades,
      minCooldownMs: EXEC_MIN_COOLDOWN_MS,
      lastTradeAt: bot.lastExecutionAt,
      estimatedGasUsd: 0,
      bid,
      ask,
    }

    const decision = shouldExecuteTrade(execSignal, ctx)

    if (!decision.approved && signal.action !== 'HOLD') {
      await appendTradingLog(bot.userId, 'FILTER', `Execution blocked: ${decision.reason}`, {
        pair,
        action: signal.action,
        confidence: signal.confidence,
      })
    }

    if (!decision.approved) return

    const allocationUsd = totalValue * proposedFraction

    await executeTrade(decision, {
      buy: async () => {
        if (allocationUsd <= 0) return
        const created = await paperOpenPosition({
          userId: bot.userId,
          strategyId: bot.strategyId,
          pair,
          entryAsk: ask,
          allocationUsd,
          execMeta: {
            actedSignal: signal.action,
            signalConfidence: signal.confidence,
            signalTriggeredAt: new Date().toISOString(),
            signalTriggerMid: mid,
            signalTriggerBid: bid,
            signalTriggerAsk: ask,
            signalPair: pair,
          },
        })
        bot.lastExecutionAt = Date.now()
        const portfolio2 = await prisma.portfolio.findUnique({
          where: { userId: bot.userId },
          select: { pnl: true },
        })
        this.emit('trade:executed', {
          userId: bot.userId,
          trade: {
            id: created.id,
            pair,
            signal: 'BUY',
            price: created.executionPrice,
            entryPrice: created.executionPrice,
            status: 'OPEN',
            confidence: signal.confidence,
          },
          currentPnl: Number(portfolio2?.pnl ?? 0),
        } satisfies TradeExecutedPayload)
      },
      sell: async () => {
        const oldest = openForPair[0]
        if (!oldest) return
        const pnl = await paperClosePosition({
          userId: bot.userId,
          tradeId: oldest.id,
          exitBid: bid,
          execMeta: {
            actedSignal: signal.action,
            signalConfidence: signal.confidence,
            signalTriggeredAt: new Date().toISOString(),
            signalTriggerMid: mid,
            signalTriggerBid: bid,
            signalTriggerAsk: ask,
            signalPair: pair,
          },
        })
        bot.lastExecutionAt = Date.now()
        const portfolio2 = await prisma.portfolio.findUnique({
          where: { userId: bot.userId },
          select: { pnl: true },
        })
        const exitExec = paperExecutionSellPrice(bid)
        this.emit('trade:executed', {
          userId: bot.userId,
          trade: {
            id: oldest.id,
            pair,
            signal: 'SELL',
            price: exitExec,
            entryPrice: Number(oldest.entryPrice),
            exitPrice: exitExec,
            pnl: pnl ?? undefined,
            status: 'CLOSED',
            confidence: signal.confidence,
          },
          currentPnl: Number(portfolio2?.pnl ?? 0),
        } satisfies TradeExecutedPayload)
      },
    })
  }
}

export const paperTradingBot = new PaperTradingBot()
export { PaperTradingBot }
export {
  computeAISignal,
  fetchBinanceKlines,
  scoreSignalFromKlines,
} from './signalEngine'
export type { AISignalResult, SignalAction } from './signalEngine'
export { RISK, checkDrawdownExceeded, validateNewBuy, countOpenPaperPositions } from './risk'
export { appendTradingLog } from './tradingLog'
export { fetchBookTicker } from './marketData'
export type { BookTicker } from './marketData'
export { PAPER_STARTING_USD } from './paperConfig'
export {
  getPaperTakerFeeBps,
  getPaperAssumedSlippageBps,
  paperExecutionBuyPrice,
  paperExecutionSellPrice,
  paperUnrealizedPnlUsd,
  paperRoundTripPnl,
} from './paperRealism'
export { paperOpenPosition, paperClosePosition } from './paperExecution'
export {
  toExecutionSignal,
  shouldExecuteTrade,
  executeTrade,
  fetchUserClosedTradeStats,
  evaluateSignal,
  calculateRiskReward,
  estimateFees,
  executeUnifiedTrade,
  EXEC_MIN_CONFIDENCE,
  EXEC_MIN_RISK_REWARD,
  EXEC_STOP_LOSS_PCT,
  EXEC_TAKE_PROFIT_PCT,
  EXEC_VOLATILITY_REJECT_PCT,
  EXEC_MAX_LOSS_TRADE_RATE,
  EXEC_MIN_COOLDOWN_MS,
  EXEC_MAX_GAS_TO_NOTIONAL,
  type ExecutionSignal,
  type ExecutionContext,
  type ShouldExecuteResult,
  type FeeEstimate,
  type RiskRewardEstimate,
  type SignalEvaluation,
  type UnifiedTradeRequest,
  type UnifiedTradeResult,
  type BinanceUnifiedExecutor,
} from './executionEngine'
export {
  executePancakeSwap,
  PancakeSwapExecutorError,
  type PancakeSwapParams,
  type PancakeSwapResult,
} from './pancakeswapExecutor'
