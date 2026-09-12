/**
 * Advanced trading bot — replaces the SMA-only liveTradingBot.
 *
 * On each 1m kline close (driven by klineService event emission),
 * the meta-policy decides BUY / SELL / HOLD.
 *
 * Paper mode: no real orders, just DB trades.
 * Live mode:  real Binance orders via orderService.
 */
import EventEmitter from 'events'
import { fetchBookTicker, paperClosePosition, paperOpenPosition } from '@cryptoflow/bot'
import { prisma } from '@cryptoflow/db'
import { logger } from '../../lib/logger'
import { decide } from './metaPolicy'
import { atr, last } from '../market/indicators'
import { klineService, klineEmitter } from '../market/klineService'

export interface AdvancedBotConfig {
  userId:     string
  strategyId: string
  symbol:     string          // e.g. "BTCUSDT"
  pair:       string          // e.g. "BTC/USDT"
  mode:       'paper' | 'live'
  orderSizeUsdtOverride?: number
}

interface BotState {
  config:          AdvancedBotConfig
  position:        'NONE' | 'LONG'
  entryPrice:      number
  stopPrice:       number   // 2 × ATR below entry
  takeProfitPrice: number   // 2 × ATR above entry (2:1 R/R)
  trailingStop:    number   // highest close since entry × (1 - 1.5 × ATR%)
  currentTradeId:  string | null
  barsInPosition:  number
  equity:          number   // USDT equity estimate (paper)
  tickHandler:     (() => void) | null
}

class AdvancedTradingBot extends EventEmitter {
  private bots = new Map<string, BotState>()

  async start(config: AdvancedBotConfig, initialEquity = 1000): Promise<void> {
    if (this.bots.has(config.userId)) {
      throw new Error('Bot already running for this user')
    }

    const state: BotState = {
      config,
      position:        'NONE',
      entryPrice:      0,
      stopPrice:       0,
      takeProfitPrice: 0,
      trailingStop:    0,
      currentTradeId:  null,
      barsInPosition:  0,
      equity:          initialEquity,
      tickHandler:     null,
    }

    this.bots.set(config.userId, state)

    // Hook into kline close events from klineService
    const onClose = (symbol: string, interval: string) => {
      if (symbol !== config.symbol || interval !== '1m') return
      this.tick(state).catch((err) =>
        logger.error({ err }, `[advancedBot] tick error for user ${config.userId}`)
      )
    }

    klineEmitter.on('kline:closed', onClose)
    state.tickHandler = () => klineEmitter.off('kline:closed', onClose)

    this.tick(state).catch(() => {})

    logger.info(`[advancedBot] Started for user ${config.userId} on ${config.symbol}`)
  }

  async stop(userId: string): Promise<void> {
    const state = this.bots.get(userId)
    if (!state) throw new Error('No active advanced bot for this user')

    // Detach kline listener
    state.tickHandler?.()

    // Close open position
    if (state.position === 'LONG' && state.currentTradeId) {
      const recent = await klineService.getRecent(state.config.symbol, '1m', 1)
      const mark = recent.length ? Number(recent[0].close) : state.entryPrice
      if (state.config.mode === 'paper') {
        const book = await fetchBookTicker(state.config.symbol)
        const exitBid = book?.bid ?? mark
        await paperClosePosition({
          userId: state.config.userId,
          tradeId: state.currentTradeId,
          exitBid,
        })
        state.position = 'NONE'
        state.currentTradeId = null
        state.entryPrice = 0
        state.stopPrice = 0
        state.takeProfitPrice = 0
        state.trailingStop = 0
        state.barsInPosition = 0
      } else {
        await this.closePosition(state, mark, 'Bot stopped')
      }
    }

    this.bots.delete(userId)
    logger.info(`[advancedBot] Stopped for user ${userId}`)
  }

  isRunning(userId: string): boolean {
    return this.bots.has(userId)
  }

  private async tick(state: BotState): Promise<void> {
    const { config } = state

    // Get current price from latest kline
    const recent = await klineService.getRecent(config.symbol, '1m', 1)
    if (!recent.length) return
    const price = Number(recent[0].close)

    // ATR-based exit management (stop-loss, take-profit, trailing stop)
    if (state.position === 'LONG') {
      const bars = await klineService.getRecent(config.symbol, '1h', 30)
      if (bars.length >= 15) {
        const highs  = bars.map((b) => Number(b.high))
        const lows   = bars.map((b) => Number(b.low))
        const closes = bars.map((b) => Number(b.close))
        const atr14  = last(atr(highs, lows, closes, 14))

        // Hard stop-loss: 2 × ATR below entry (set at open)
        if (price <= state.stopPrice) {
          logger.warn(`[advancedBot] Stop-loss triggered at ${price} (stop=${state.stopPrice.toFixed(2)})`)
          await this.closePosition(state, price, 'Stop-loss')
          return
        }

        // Take-profit: 2 × ATR above entry (2:1 R/R)
        if (price >= state.takeProfitPrice && state.takeProfitPrice > 0) {
          logger.info(`[advancedBot] Take-profit triggered at ${price} (tp=${state.takeProfitPrice.toFixed(2)})`)
          await this.closePosition(state, price, 'Take-profit')
          return
        }

        // Trailing stop: once up > 1 × ATR, trail at 1.5 × ATR below recent high
        if (price > state.entryPrice + atr14) {
          const newTrail = price - 1.5 * atr14
          if (newTrail > state.trailingStop) {
            state.trailingStop = newTrail
          }
          if (price <= state.trailingStop) {
            logger.info(`[advancedBot] Trailing stop triggered at ${price} (trail=${state.trailingStop.toFixed(2)})`)
            await this.closePosition(state, price, 'Trailing-stop')
            return
          }
        }
      }
    }

    const unrealizedPnlPct = state.position === 'LONG' && state.entryPrice > 0
      ? (price - state.entryPrice) / state.entryPrice
      : 0

    const decision = await decide(
      config.symbol,
      config.userId,
      state.position === 'LONG' ? 1 : 0,
      unrealizedPnlPct,
      state.barsInPosition,
      state.equity,
    )

    logger.info(
      `[advancedBot] ${config.symbol} pUp=${decision.pUp.toFixed(3)} ` +
      `action=${decision.action} pos=${state.position} kelly=${decision.orderSizeUsdt.toFixed(2)}USDT`
    )

    if (decision.action === 'BUY' && state.position === 'NONE') {
      await this.openPosition(state, price, decision.orderSizeUsdt)
    } else if (decision.action === 'SELL' && state.position === 'LONG') {
      await this.closePosition(state, price, 'Signal')
    }

    if (state.position === 'LONG') {
      state.barsInPosition++
    }
  }

  private async openPosition(state: BotState, markPrice: number, sizeUsdt: number): Promise<void> {
    const { config } = state

    let atrVal = markPrice * 0.01
    try {
      const bars = await klineService.getRecent(config.symbol, '1h', 30)
      if (bars.length >= 15) {
        const h = bars.map((b) => Number(b.high))
        const l = bars.map((b) => Number(b.low))
        const c = bars.map((b) => Number(b.close))
        atrVal = last(atr(h, l, c, 14)) || atrVal
      }
    } catch { /* use fallback */ }

    if (config.mode === 'paper') {
      const book = await fetchBookTicker(config.symbol)
      const entryAsk = book?.ask ?? markPrice
      const allocationUsd = Math.max(10, sizeUsdt)

      const created = await paperOpenPosition({
        userId: config.userId,
        strategyId: config.strategyId,
        pair: config.pair,
        entryAsk,
        allocationUsd,
      })

      const execPx = created.executionPrice
      state.position = 'LONG'
      state.entryPrice = execPx
      state.stopPrice = execPx - 2 * atrVal
      state.takeProfitPrice = execPx + 2 * atrVal
      state.trailingStop = 0
      state.currentTradeId = created.id
      state.barsInPosition = 0

      const portfolio = await prisma.portfolio.findUnique({
        where: { userId: config.userId },
        select: { pnl: true },
      })

      logger.info(
        `[advancedBot] OPEN LONG (paper) ${config.pair} exec ${execPx.toFixed(4)} (touch ${entryAsk.toFixed(4)}) ` +
          `stop=${state.stopPrice.toFixed(2)} tp=${state.takeProfitPrice.toFixed(2)} alloc=$${allocationUsd.toFixed(2)}`,
      )

      this.emit('trade:executed', {
        userId: config.userId,
        trade: {
          id: created.id,
          pair: config.pair,
          signal: 'BUY',
          price: execPx,
          entryPrice: execPx,
          status: 'OPEN',
        },
        currentPnl: Number(portfolio?.pnl ?? 0),
      })
      return
    }

    const trade = await prisma.trade.create({
      data: {
        userId: config.userId,
        strategyId: config.strategyId,
        pair: config.pair,
        entryPrice: markPrice,
        status: 'OPEN',
      },
    })

    state.position = 'LONG'
    state.entryPrice = markPrice
    state.stopPrice = markPrice - 2 * atrVal
    state.takeProfitPrice = markPrice + 2 * atrVal
    state.trailingStop = 0
    state.currentTradeId = trade.id
    state.barsInPosition = 0

    logger.info(
      `[advancedBot] OPEN LONG ${config.pair} @ ${markPrice} ` +
        `stop=${state.stopPrice.toFixed(2)} tp=${state.takeProfitPrice.toFixed(2)} ` +
        `(${sizeUsdt.toFixed(2)} USDT)`,
    )

    this.emit('trade:executed', {
      userId: config.userId,
      trade: { id: trade.id, pair: config.pair, signal: 'BUY', price: markPrice, entryPrice: markPrice, status: 'OPEN' },
      currentPnl: 0,
    })
  }

  private async closePosition(state: BotState, markPrice: number, reason: string): Promise<void> {
    if (!state.currentTradeId) return

    const { config } = state

    if (config.mode === 'paper') {
      const book = await fetchBookTicker(config.symbol)
      const exitBid = book?.bid ?? markPrice
      const tradeId = state.currentTradeId
      const entryPrice = state.entryPrice
      const pnl = await paperClosePosition({
        userId: config.userId,
        tradeId,
        exitBid,
      })
      if (pnl === null) return

      state.equity += pnl
      state.position = 'NONE'
      state.entryPrice = 0
      state.stopPrice = 0
      state.takeProfitPrice = 0
      state.trailingStop = 0
      state.currentTradeId = null
      state.barsInPosition = 0

      const portfolio = await prisma.portfolio.findUnique({
        where: { userId: config.userId },
        select: { pnl: true },
      })

      logger.info(`[advancedBot] CLOSE (paper) ${config.pair} touch bid ${exitBid.toFixed(4)} net PnL=${pnl.toFixed(4)} reason=${reason}`)

      this.emit('trade:executed', {
        userId: config.userId,
        trade: {
          id: tradeId,
          pair: config.pair,
          signal: 'SELL',
          price: exitBid,
          entryPrice,
          exitPrice: exitBid,
          pnl,
          status: 'CLOSED',
        },
        currentPnl: Number(portfolio?.pnl ?? 0),
      })
      return
    }

    const entryPrice = state.entryPrice
    const tradeId = state.currentTradeId
    const pnl = markPrice - entryPrice

    await prisma.trade.update({
      where: { id: tradeId },
      data: { exitPrice: markPrice, pnl, status: 'CLOSED' },
    })

    await prisma.portfolio.updateMany({
      where: { userId: config.userId },
      data: { pnl: { increment: pnl }, totalValue: { increment: pnl } },
    })

    state.equity += pnl
    state.position = 'NONE'
    state.entryPrice = 0
    state.stopPrice = 0
    state.takeProfitPrice = 0
    state.trailingStop = 0
    state.currentTradeId = null
    state.barsInPosition = 0

    const portfolio = await prisma.portfolio.findUnique({
      where: { userId: config.userId },
      select: { pnl: true },
    })

    logger.info(`[advancedBot] CLOSE ${config.pair} @ ${markPrice} PnL=${pnl.toFixed(2)} reason=${reason}`)

    this.emit('trade:executed', {
      userId: config.userId,
      trade: {
        id: tradeId,
        pair: config.pair,
        signal: 'SELL',
        price: markPrice,
        entryPrice,
        exitPrice: markPrice,
        pnl,
        status: 'CLOSED',
      },
      currentPnl: Number(portfolio?.pnl ?? 0),
    })
  }
}

export const advancedBot = new AdvancedTradingBot()
