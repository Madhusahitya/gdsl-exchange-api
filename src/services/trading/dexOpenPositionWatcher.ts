/**
 * Server-side watcher for OPEN DEX Personal Wallet positions.
 *
 * Auto-exit uses Pancake router quotes (same routes as executePersonalSwap)
 * so we only sell when on-chain exit would actually beat entry + TP — not
 * when Binance mid alone crosses a tiny threshold.
 */

import { formatUnits, parseUnits } from 'ethers'
import { TradeStatus, prisma } from '@cryptoflow/db'
import { env } from '../../lib/env'
import { estimatedNetRoundTripUsd } from '../../lib/roundTripPnl'
import { logger } from '../../lib/logger'
import { computeTrendRsiSignal } from '../../lib/dexSignalMath'
import {
  executePersonalSwap,
  getPersonalWalletTokenBalance,
  getPersonalWalletTokenBalanceRaw,
  quoteTokenToUsdt,
  sellAmountRawFromBalance,
  isPersonalWalletEnabled,
  PERSONAL_WALLET_TOKENS,
} from '../wallet/personalWalletService'
import { telegramService } from '../notifications/telegramService'
import { getSocketIo } from '../../lib/realtimeHub'

const WATCH_INTERVAL_MS = 30_000
const COOLDOWN_MS = 45_000
const KLINE_LIMIT = 32
const LOT_QTY_EPS = 1e-10

/** tradeId → last attempt timestamp */
const exitCooldown = new Map<string, number>()

let strategyIdCache: string | null = null

async function dexPersonalStrategyId(): Promise<string> {
  if (strategyIdCache) return strategyIdCache
  const s = await prisma.strategy.upsert({
    where: { name: 'DEX Personal Wallet' },
    update: {},
    create: {
      name: 'DEX Personal Wallet',
      description: 'Server-signed personal wallet swaps.',
      riskLevel: 'MEDIUM',
    },
    select: { id: true },
  })
  strategyIdCache = s.id
  return s.id
}

async function fetchBinanceKlineCloses(binanceSymbol: string): Promise<number[]> {
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(binanceSymbol)}&interval=1m&limit=${KLINE_LIMIT}`,
    )
    if (!res.ok) return []
    const rows = (await res.json()) as unknown[]
    if (!Array.isArray(rows)) return []
    const closes: number[] = []
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 5) continue
      const close = typeof row[4] === 'string' ? parseFloat(row[4]) : NaN
      if (Number.isFinite(close) && close > 0) closes.push(close)
    }
    return closes
  } catch {
    return []
  }
}

async function fetchMarkPrice(binanceSymbol: string | null): Promise<number | null> {
  if (!binanceSymbol) return null
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(binanceSymbol)}`,
    )
    if (!res.ok) return null
    const data = (await res.json()) as { price?: string }
    const p = data.price ? parseFloat(data.price) : NaN
    return Number.isFinite(p) && p > 0 ? p : null
  } catch {
    return null
  }
}

type ExitReason = 'take_profit' | 'stop_loss' | 'signal_sell'

function reasonLabel(reason: ExitReason, pct: number): string {
  if (reason === 'take_profit') return `Take-profit (+${pct.toFixed(2)}% Pancake quote)`
  if (reason === 'stop_loss') return `Stop-loss (${pct.toFixed(2)}%)`
  return `SELL signal (+${pct.toFixed(2)}% Pancake quote)`
}

async function tryExitOpenTrade(trade: {
  id: string
  userId: string
  pair: string
  entryPrice: { toString(): string }
  allocationUsd: { toString(): string } | null
}): Promise<void> {
  const last = exitCooldown.get(trade.id) ?? 0
  if (Date.now() - last < COOLDOWN_MS) return

  const baseSymbol = trade.pair.split('/')[0]?.toUpperCase() ?? ''
  const token = PERSONAL_WALLET_TOKENS.find((t) => t.symbol === baseSymbol)
  if (!token?.binanceSymbol) return
  if (!token.address && token.symbol !== 'BNB') return

  const entry = Number(trade.entryPrice)
  const buyAlloc = Number(trade.allocationUsd ?? 0)
  if (!Number.isFinite(entry) || entry <= 0) return

  const mark = await fetchMarkPrice(token.binanceSymbol)
  if (mark === null) return

  const binancePct = ((mark - entry) / entry) * 100
  const tp = env.dexAutoTakeProfitPct
  const sl = env.dexAutoStopLossPct
  const minSignalProfit = env.dexSignalExitMinProfitPct
  const slippageBps = env.dexAutoExitSlippageBps
  const minNetUsd = env.dexMinNetProfitUsd

  const lotQty = buyAlloc > 0 ? buyAlloc / entry : 0
  const walletBal = await getPersonalWalletTokenBalance(trade.userId, token.symbol)

  if (lotQty > LOT_QTY_EPS && walletBal < lotQty * 0.05) {
    await prisma.trade.update({
      where: { id: trade.id },
      data: { status: TradeStatus.CANCELLED },
    })
    logger.info(
      { tradeId: trade.id, userId: trade.userId, pair: trade.pair, walletBal, lotQty },
      '[dexWatcher] cancelled stale OPEN (wallet empty for this lot)',
    )
    return
  }

  const balanceRaw = await getPersonalWalletTokenBalanceRaw(trade.userId, token.symbol)
  if (balanceRaw <= 0n) {
    logger.warn({ tradeId: trade.id, userId: trade.userId }, '[dexWatcher] no token balance to sell')
    return
  }

  let sellRaw = sellAmountRawFromBalance(balanceRaw)
  if (lotQty > LOT_QTY_EPS) {
    const lotRaw = parseUnits(
      lotQty.toFixed(Math.min(12, token.decimals)),
      token.decimals,
    )
    const lotCap = (lotRaw * 102n) / 100n
    if (sellRaw > lotCap) sellRaw = sellAmountRawFromBalance(lotCap)
  }

  const sellAmount = Number(formatUnits(sellRaw, token.decimals))
  if (sellAmount <= LOT_QTY_EPS) {
    logger.warn({ tradeId: trade.id, userId: trade.userId }, '[dexWatcher] no token balance to sell')
    return
  }

  const quote = await quoteTokenToUsdt(token, sellRaw)
  if (!quote) return

  const pancakePct = ((quote.exitPriceUsd - entry) / entry) * 100
  const estNetUsd = estimatedNetRoundTripUsd(
    buyAlloc > 0 ? buyAlloc : sellAmount * entry,
    entry,
    quote.exitPriceUsd,
    slippageBps,
  )

  let reason: ExitReason | null = null
  if (pancakePct >= tp && estNetUsd >= minNetUsd) {
    reason = 'take_profit'
  } else if (binancePct <= -sl || pancakePct <= -sl) {
    reason = 'stop_loss'
  } else {
    const closes = await fetchBinanceKlineCloses(token.binanceSymbol)
    if (closes.length >= 18) {
      const { signal } = computeTrendRsiSignal(closes, {
        smaPeriod: 8,
        threshold: env.dexSignalThresholdFrac,
        useRsiFilter: false,
        rsiBuyMax: 70,
        rsiSellMin: 28,
      })
      if (signal === 'SELL' && pancakePct >= minSignalProfit && estNetUsd >= minNetUsd) {
        reason = 'signal_sell'
      }
    }
  }

  if (!reason) return

  exitCooldown.set(trade.id, Date.now())

  try {
    const result = await executePersonalSwap(trade.userId, {
      side: 'SELL',
      tokenSymbol: token.symbol,
      amount: sellAmount,
      slippageBps: env.dexAutoExitSlippageBps,
      closeTradeId: trade.id,
      sellAmountRaw: sellRaw,
    })

    const realized =
      result.trade.pnl != null && Number.isFinite(result.trade.pnl) ? result.trade.pnl : null
    const exitPx = result.trade.exitPrice ?? quote.exitPriceUsd

    void telegramService
      .notifyDexBotTrade({
        userId: trade.userId,
        action: 'SELL',
        pair: trade.pair,
        reason: reasonLabel(reason, pancakePct),
        fillPriceUsd: exitPx,
        entryPriceUsd: entry,
        usdtSpent: buyAlloc > 0 ? buyAlloc : undefined,
        usdtReceived: result.trade.side === 'CLOSED' ? Number(result.expectedOut) : undefined,
        realizedPnlUsd: realized,
        unrealizedPct: pancakePct,
        txHash: result.txHash,
        trigger: 'auto',
      })
      .catch(() => null)

    const io = getSocketIo()
    if (io) {
      io.to(`user:${trade.userId}`).emit('trade:executed', {
        trade: {
          id: result.trade.id,
          pair: result.trade.pair,
          signal: 'SELL',
          entryPrice: result.trade.entryPrice,
          exitPrice: result.trade.exitPrice,
          pnl: result.trade.pnl,
          status: result.trade.status,
          side: result.trade.side,
        },
        currentPnl: result.trade.pnl ?? 0,
      })
    }

    logger.info(
      {
        tradeId: trade.id,
        userId: trade.userId,
        pair: trade.pair,
        reason,
        binancePct,
        pancakePct,
        estNetUsd,
        sellAmount,
        realized,
        txHash: result.txHash,
      },
      '[dexWatcher] auto-exit executed',
    )
  } catch (err) {
    exitCooldown.delete(trade.id)
    const msg = err instanceof Error ? err.message : 'exit failed'
    logger.warn({ tradeId: trade.id, err: msg }, '[dexWatcher] auto-exit failed')
    void telegramService
      .notifyTradeFailed({
        userId: trade.userId,
        symbol: token.symbol,
        side: 'SELL',
        errorType: 'dex_auto_exit',
        message: msg.slice(0, 1500),
      })
      .catch(() => null)
  }
}

export async function runDexOpenPositionWatcher(): Promise<void> {
  if (!env.dexServerAutoExit || !isPersonalWalletEnabled()) return

  try {
    const strategyId = await dexPersonalStrategyId()
    const openTrades = await prisma.trade.findMany({
      where: { strategyId, status: TradeStatus.OPEN },
      select: {
        id: true,
        userId: true,
        pair: true,
        entryPrice: true,
        allocationUsd: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 40,
    })

    for (const t of openTrades) {
      await tryExitOpenTrade(t)
      await new Promise((r) => setTimeout(r, 250))
    }
  } catch (err) {
    logger.error({ err }, '[dexWatcher] run failed')
  }
}

let watcherStarted = false

export function startDexOpenPositionWatcher(): void {
  if (watcherStarted) return
  watcherStarted = true
  if (!env.dexServerAutoExit) {
    logger.info('[dexWatcher] DEX_SERVER_AUTO_EXIT=off — server auto-exit disabled')
    return
  }
  logger.info(
    {
      intervalMs: WATCH_INTERVAL_MS,
      tpPct: env.dexAutoTakeProfitPct,
      slPct: env.dexAutoStopLossPct,
      minSignalProfitPct: env.dexSignalExitMinProfitPct,
    },
    '[dexWatcher] started (Pancake-quoted TP)',
  )
  void runDexOpenPositionWatcher()
  setInterval(() => {
    void runDexOpenPositionWatcher()
  }, WATCH_INTERVAL_MS)
}
