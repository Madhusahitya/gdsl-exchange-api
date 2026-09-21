/**
 * equityService — single source of truth for a user's account equity.
 *
 * Why: legacy code seeded new users with a $10,000 "paper" baseline in
 * Portfolio.totalValue and the deposit/withdraw routes incremented from
 * that baseline. Now that we are real-funds-only, the dashboard MUST
 * show numbers that match the user's actual money flows:
 *
 *     equity  =   sum(completed deposits)
 *               − sum(completed withdrawals)
 *               + sum(closed-trade realized PnL)
 *               + open-position mark-to-market gain/loss   (live)
 *
 * The first three components are derived deterministically from the
 * ledger tables (Deposit / Withdrawal / Trade). The fourth is computed
 * by pricing every StrategyPosition with a live Binance ticker.
 *
 * The helper also reconciles `Portfolio.totalValue` whenever it drifts
 * from the ledger (e.g. an old account still carries the $10k seed) so
 * that any other code path reading Portfolio.totalValue eventually
 * converges on the true number.
 */

import {
  prisma,
  TradeStatus,
  WithdrawalStatus,
  DepositStatus,
  type Prisma,
} from '@cryptoflow/db'
import { BSC_TOKEN_BINANCE_BY_SYMBOL } from '../../lib/bscTokenCatalog'
import { SOL_TOKEN_BINANCE_BY_SYMBOL } from '../../lib/solDexCatalog'
import { displayRoundTripPnl, shouldIncludeClosedTradeInPublicLog } from '../../lib/roundTripPnl'
import { logger } from '../../lib/logger'
import { quoteOneInchSellUsdPerToken } from '../dex/oneInchMarkService'
import { quoteJupiterSellUsdPerToken } from '../dex/jupiterMarkService'
import { JUPITER_STRATEGY_NAME, reconcileStaleJupiterOpenTrades } from '../dex/jupiterSwapService'
import { JUPITER_SELF_CUSTODY_STRATEGY_NAME } from '../dex/jupiterBrowserSwapService'
import { buildAutoBinanceOpenPositions } from '../trading/cexOpenPositionService'
export const ONEINCH_STRATEGY_NAME = 'DEX 1inch BSC'
export { JUPITER_STRATEGY_NAME }

/**
 * Trades signed by the user's own browser wallet are excluded from platform
 * equity and platform performance stats. Those funds never came through a
 * platform deposit, so counting them would overstate both the balance and the
 * strategy's track record.
 */
const EXCLUDE_SELF_CUSTODY = {
  strategy: { name: { not: JUPITER_SELF_CUSTODY_STRATEGY_NAME } },
} as const

const BINANCE_REST = 'https://api.binance.com'

const priceCache = new Map<string, { price: number; ts: number }>()
const PRICE_TTL_MS = 1_500

async function fetchSpotPrice(symbol: string): Promise<number | null> {
  const cached = priceCache.get(symbol)
  if (cached && Date.now() - cached.ts < PRICE_TTL_MS) return cached.price
  try {
    const res = await fetch(`${BINANCE_REST}/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return cached?.price ?? null
    const data = (await res.json()) as { bidPrice?: string; askPrice?: string }
    const bid = parseFloat(String(data.bidPrice ?? ''))
    const ask = parseFloat(String(data.askPrice ?? ''))
    const price =
      Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0
        ? (bid + ask) / 2
        : NaN
    if (!Number.isFinite(price) || price <= 0) return cached?.price ?? null
    priceCache.set(symbol, { price, ts: Date.now() })
    return price
  } catch {
    return cached?.price ?? null
  }
}

export type OpenPositionSnapshot = {
  symbol: string
  quantity: number
  avgEntryPrice: number | null
  /**
   * Live Binance spot mid — same reference the DEX terminal polls for
   * signals, TP/SL, and the server `dexWatcher` auto-exit job.
   */
  markPrice: number | null
  marketValueUsd: number
  costBasisUsd: number
  unrealizedPnlUsd: number
  unrealizedPnlPct: number | null
  updatedAt: string
  /** Present when mark comes from Binance public ticker (bot reference). */
  markSource?: 'binance_spot' | 'oneinch_quote' | 'jupiter_quote' | 'wallet_live'
  /** Binance spot reference (shown next to 1inch exit mark). */
  binanceRefPrice?: number | null
  /** Strategy book name for this row (e.g. DEX 1inch BSC). */
  strategyBook?: string
  /** Trading pair e.g. LTC/USDT — for manual sell from dashboard. */
  pair?: string
  /** OPEN trade row ids aggregated into this symbol row (DEX personal wallet). */
  openTradeIds?: string[]
  /** Profit already sold to stables via skims while the position stays open. */
  skimmedUsd?: number
}

export type EquitySnapshot = {
  /** Cash equity = deposits - withdrawals + realized PnL (lifetime). */
  realizedEquity: number
  /** Live mark-to-market value of all open positions. */
  openPositionsMarketValue: number
  /** Cost basis of all open positions. */
  openPositionsCostBasis: number
  /** marketValue - costBasis. */
  unrealizedPnl: number
  /** realizedEquity + unrealizedPnl — the true wallet figure shown in the UI. */
  liveEquity: number
  /** Sum of completed deposits. */
  totalDeposits: number
  /** Sum of completed withdrawals. */
  totalWithdrawals: number
  /** Realized PnL across all CLOSED trades, all-time. */
  realizedPnlAllTime: number
  positions: OpenPositionSnapshot[]
}

export type LedgerWindow = {
  /** Deposits (USD) inside the window. */
  deposits: number
  /** Withdrawals (USD) inside the window. */
  withdrawals: number
  /** Realized PnL (USD) from CLOSED trades inside the window. */
  realizedPnl: number
  /** Trade count inside the window. */
  tradeCount: number
  /** Wins (pnl > 0) inside the window. */
  wins: number
  /** Losses (pnl < 0) inside the window. */
  losses: number
  /** Best single closed trade PnL inside the window. */
  bestTrade: number
  /** Worst single closed trade PnL inside the window. */
  worstTrade: number
  /**
   * Mean PnL of winning trades (positive USD per win). `0` when no wins.
   * Used to compute payoff ratio and expectancy on the dashboard.
   */
  avgWinUsd: number
  /**
   * Mean ABSOLUTE PnL of losing trades (positive USD per loss). `0` when no
   * losses. Stored as a positive number so the UI doesn't have to flip signs
   * to print "Avg loss: $0.50".
   */
  avgLossUsd: number
  /**
   * Expectancy = (winRate × avgWin) − (lossRate × avgLoss), in USD per trade.
   * Positive ⇒ strategy is statistically profitable across this window;
   * negative ⇒ it loses money on average. The single most-important honest
   * metric to show investors.
   */
  expectancyUsd: number
  /**
   * Payoff ratio = avgWin / avgLoss. >1 means winners are bigger than losers
   * (good); <1 means losers outpace winners and you need a high win rate to
   * break even. `0` when there are no losses yet (can't divide).
   */
  payoffRatio: number
}

function decimalToNumber(value: Prisma.Decimal | null | undefined): number {
  if (value == null) return 0
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** Safe fallback when equity computation fails — dashboard must never 500. */
export const EMPTY_EQUITY_SNAPSHOT: EquitySnapshot = {
  realizedEquity: 0,
  openPositionsMarketValue: 0,
  openPositionsCostBasis: 0,
  unrealizedPnl: 0,
  liveEquity: 0,
  totalDeposits: 0,
  totalWithdrawals: 0,
  realizedPnlAllTime: 0,
  positions: [],
}

/** Compute the user's equity from the ledger and live prices. */
export async function computeUserEquity(userId: string): Promise<EquitySnapshot> {
  // Drop Jupiter book ghosts before reading OPEN trades (wallet already empty).
  await reconcileStaleJupiterOpenTrades(userId).catch(() => 0)

  // IMPORTANT: when we filter CLOSED trades for "realized PnL" we now also
  // require `exitPrice IS NOT NULL`. That excludes two categories of rows
  // that the new position-lifecycle code intentionally leaves null:
  //   1. Pre-fix CLOSED rows (history, before the lifecycle rewrite) — those
  //      were just slippage-vs-quote dust and shouldn't count as P&L.
  //   2. Orphan SELLs (no matching open BUY in the same book) — recorded
  //      for audit but never represent a real round-trip.
  // Only rows with both legs (entryPrice + exitPrice) and a pnl figure
  // computed by the SELL handler contribute to realized PnL and to
  // win-rate / expectancy stats.
  const [depositsAgg, withdrawalsAgg, closedTrades, openPositions, openDexTrades] = await Promise.all([
    prisma.deposit.aggregate({
      where: { userId, status: DepositStatus.COMPLETED },
      _sum: { amount: true },
    }),
    prisma.withdrawal.aggregate({
      where: { userId, status: WithdrawalStatus.COMPLETED },
      _sum: { amount: true },
    }),
    prisma.trade.findMany({
      where: { userId, status: TradeStatus.CLOSED, exitPrice: { not: null }, ...EXCLUDE_SELF_CUSTODY },
      select: {
        pair: true,
        pnl: true,
        allocationUsd: true,
        entryPrice: true,
        exitPrice: true,
        strategy: { select: { name: true } },
      },
    }),
    prisma.strategyPosition.findMany({
      where: { userId, quantity: { gt: 0 } },
      select: { symbol: true, quantity: true, avgEntryPrice: true, updatedAt: true },
    }),
    // DEX OPEN trades — these are real held positions from server-signed
    // BSC swaps (Trade.status=OPEN). We aggregate them by pair so the
    // dashboard's "Open positions" counter reflects every distinct held
    // token, not just paper / AI bot positions stored in StrategyPosition.
    prisma.trade.findMany({
      where: { userId, status: TradeStatus.OPEN, ...EXCLUDE_SELF_CUSTODY },
      select: {
        id: true,
        pair: true,
        entryPrice: true,
        allocationUsd: true,
        createdAt: true,
        // On an OPEN Jupiter lot, pnl > 0 is profit already skimmed to USDC.
        pnl: true,
        strategy: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  const totalDeposits = decimalToNumber(depositsAgg._sum.amount)
  const totalWithdrawals = decimalToNumber(withdrawalsAgg._sum.amount)
  const realizedPnlAllTime = closedTrades.reduce((acc, t) => {
    const row = {
      pnl: t.pnl,
      allocationUsd: t.allocationUsd,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      pair: t.pair,
      strategyName: t.strategy.name,
    }
    if (!shouldIncludeClosedTradeInPublicLog(row)) return acc
    const pnl = displayRoundTripPnl(row)
    return acc + (pnl ?? 0)
  }, 0)
  const realizedEquity = totalDeposits - totalWithdrawals + realizedPnlAllTime

  const positions: OpenPositionSnapshot[] = []
  let openPositionsMarketValue = 0
  let openPositionsCostBasis = 0

  const strategyMarks = await Promise.all(
    openPositions.map(async (pos) => ({
      pos,
      markPrice: await fetchSpotPrice(pos.symbol),
    })),
  )
  for (const { pos, markPrice } of strategyMarks) {
    const qty = decimalToNumber(pos.quantity)
    const avgEntry = pos.avgEntryPrice == null ? null : decimalToNumber(pos.avgEntryPrice)
    if (qty <= 0) continue
    const costBasis = avgEntry != null ? qty * avgEntry : 0
    const marketValue = markPrice != null ? qty * markPrice : costBasis
    const unrealized = marketValue - costBasis
    const unrealizedPct = costBasis > 0 ? (unrealized / costBasis) * 100 : null

    openPositionsMarketValue += marketValue
    openPositionsCostBasis += costBasis
    positions.push({
      symbol: pos.symbol,
      quantity: qty,
      avgEntryPrice: avgEntry,
      markPrice,
      marketValueUsd: marketValue,
      costBasisUsd: costBasis,
      unrealizedPnlUsd: unrealized,
      unrealizedPnlPct: unrealizedPct,
      updatedAt: pos.updatedAt.toISOString(),
    })
  }

  // Aggregate DEX OPEN trades by symbol + strategy book (1inch vs Pancake are separate).
  type OpenAccum = {
    totalQty: number
    totalCost: number
    latestAt: Date
    pair: string
    tradeIds: string[]
    strategyBook: string
    skimmedUsd: number
  }
  const dexAggregate = new Map<string, OpenAccum>()
  for (const t of openDexTrades) {
    const entry = decimalToNumber(t.entryPrice)
    const alloc = decimalToNumber(t.allocationUsd)
    if (entry <= 0 || alloc <= 0) continue
    const baseSymbol = (t.pair.split('/')[0] ?? t.pair).toUpperCase()
    const strategyBook = t.strategy?.name ?? 'DEX'
    const aggKey = `${baseSymbol}::${strategyBook}`
    const qty = alloc / entry
    const existing = dexAggregate.get(aggKey) ?? {
      totalQty: 0,
      totalCost: 0,
      latestAt: t.createdAt,
      pair: t.pair,
      tradeIds: [],
      strategyBook,
      skimmedUsd: 0,
    }
    existing.totalQty += qty
    existing.totalCost += alloc
    existing.tradeIds.push(t.id)
    const skimmed = decimalToNumber(t.pnl)
    if (skimmed > 0) existing.skimmedUsd += skimmed
    if (t.createdAt > existing.latestAt) existing.latestAt = t.createdAt
    dexAggregate.set(aggKey, existing)
  }

  const dexEntries = await Promise.all(
    [...dexAggregate.entries()].map(async ([, acc]) => {
      if (acc.totalQty <= 0) return null
      const symbol = (acc.pair.split('/')[0] ?? acc.pair).toUpperCase()
      const avgEntry = acc.totalCost / acc.totalQty
      const isOneInch = acc.strategyBook === ONEINCH_STRATEGY_NAME
      const isJupiter = acc.strategyBook === JUPITER_STRATEGY_NAME
      const binanceSym = isJupiter
        ? (SOL_TOKEN_BINANCE_BY_SYMBOL[symbol] ?? `${symbol}USDT`)
        : BSC_TOKEN_BINANCE_BY_SYMBOL[symbol]
      const binanceRef =
        !isJupiter && binanceSym != null ? await fetchSpotPrice(binanceSym) : null
      const mark = isOneInch
        ? (await quoteOneInchSellUsdPerToken(symbol, acc.totalQty)) ?? binanceRef
        : isJupiter
          ? (await quoteJupiterSellUsdPerToken(symbol, acc.totalQty)) ?? null
          : binanceRef
      const costBasis = acc.totalCost
      const marketValue = mark != null ? acc.totalQty * mark : costBasis
      const unrealized = marketValue - costBasis
      const unrealizedPct = costBasis > 0 ? (unrealized / costBasis) * 100 : null

      const markSource: OpenPositionSnapshot['markSource'] = isOneInch
        ? mark != null
          ? 'oneinch_quote'
          : undefined
        : isJupiter
          ? mark != null
            ? 'jupiter_quote'
            : undefined
          : mark != null
            ? 'binance_spot'
            : undefined

      return {
        symbol,
        pair: acc.pair,
        openTradeIds: acc.tradeIds,
        quantity: acc.totalQty,
        avgEntryPrice: avgEntry,
        markPrice: mark,
        binanceRefPrice: isJupiter ? undefined : binanceRef,
        strategyBook: acc.strategyBook,
        marketValueUsd: marketValue,
        costBasisUsd: costBasis,
        unrealizedPnlUsd: unrealized,
        unrealizedPnlPct: unrealizedPct,
        updatedAt: acc.latestAt.toISOString(),
        markSource,
        skimmedUsd: acc.skimmedUsd > 0 ? acc.skimmedUsd : undefined,
        costBasis,
        marketValue,
      }
    }),
  )

  for (const entry of dexEntries) {
    if (!entry) continue
    openPositionsMarketValue += entry.marketValue
    openPositionsCostBasis += entry.costBasis
    const { costBasis: _cb, marketValue: _mv, ...pos } = entry
    positions.push(pos)
  }

  const cexAutoPositions = await buildAutoBinanceOpenPositions(userId, positions).catch(() => [])
  for (const pos of cexAutoPositions) {
    openPositionsMarketValue += pos.marketValueUsd
    openPositionsCostBasis += pos.costBasisUsd
    positions.push(pos)
  }

  const unrealizedPnl = openPositionsMarketValue - openPositionsCostBasis
  const liveEquity = realizedEquity + unrealizedPnl

  return {
    realizedEquity,
    openPositionsMarketValue,
    openPositionsCostBasis,
    unrealizedPnl,
    liveEquity,
    totalDeposits,
    totalWithdrawals,
    realizedPnlAllTime,
    positions,
  }
}

/**
 * Aggregate ledger activity inside a window (used for daily/weekly summaries).
 * `to` is exclusive, `from` is inclusive, both as absolute dates.
 */
export async function summarizeLedgerWindow(
  userId: string,
  from: Date,
  to: Date,
): Promise<LedgerWindow> {
  const range = { gte: from, lt: to }
  const [depositsAgg, withdrawalsAgg, trades] = await Promise.all([
    prisma.deposit.aggregate({
      where: { userId, status: DepositStatus.COMPLETED, createdAt: range },
      _sum: { amount: true },
    }),
    prisma.withdrawal.aggregate({
      where: { userId, status: WithdrawalStatus.COMPLETED, createdAt: range },
      _sum: { amount: true },
    }),
    prisma.trade.findMany({
      // Same `exitPrice IS NOT NULL` filter as computeUserEquity. Without
      // it, pre-fix slippage-delta rows (Realized ~$0.0003) and any new
      // orphan SELL rows would pollute the win-rate, average win/loss,
      // expectancy and payoff numbers. After this filter the widget shows
      // ONLY real BUY-then-SELL round-trips, which is what investors
      // actually want to evaluate. Sample sizes will look smaller until
      // round-trips happen — the dashboard already renders a "Low sample"
      // chip when there are fewer than 5 round-trips in the window.
      where: {
        userId,
        status: TradeStatus.CLOSED,
        exitPrice: { not: null },
        createdAt: range,
        ...EXCLUDE_SELF_CUSTODY,
      },
      select: {
        pair: true,
        pnl: true,
        allocationUsd: true,
        entryPrice: true,
        exitPrice: true,
        strategy: { select: { name: true } },
      },
    }),
  ])

  let realizedPnl = 0
  let wins = 0
  let losses = 0
  let bestTrade = 0
  let worstTrade = 0
  let winsPnlSum = 0
  let lossesPnlAbsSum = 0
  let tradeCount = 0
  /** Ignore noise around zero so $0.00 slippage rows don’t count as a “loss”. */
  const pnlWinLossEps = 1e-6
  for (const t of trades) {
    const row = {
      pnl: t.pnl,
      allocationUsd: t.allocationUsd,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      pair: t.pair,
      strategyName: t.strategy.name,
    }
    if (!shouldIncludeClosedTradeInPublicLog(row)) continue
    const pnl = displayRoundTripPnl(row)
    if (pnl == null) continue
    tradeCount += 1
    realizedPnl += pnl
    if (pnl > pnlWinLossEps) {
      wins += 1
      winsPnlSum += pnl
    } else if (pnl < -pnlWinLossEps) {
      losses += 1
      lossesPnlAbsSum += -pnl
    }
    if (pnl > bestTrade) bestTrade = pnl
    if (pnl < worstTrade) worstTrade = pnl
  }

  const avgWinUsd = wins > 0 ? winsPnlSum / wins : 0
  const avgLossUsd = losses > 0 ? lossesPnlAbsSum / losses : 0
  // Expectancy: E[$ per trade] across the window. Both probabilities derive
  // from the SAME denominator (trade count, including any zero-PnL trades
  // that fell inside the ±epsilon band) so this stays consistent with the
  // win-rate the UI is already displaying.
  const winRateFrac = tradeCount > 0 ? wins / tradeCount : 0
  const lossRateFrac = tradeCount > 0 ? losses / tradeCount : 0
  const expectancyUsd = winRateFrac * avgWinUsd - lossRateFrac * avgLossUsd
  const payoffRatio = avgLossUsd > 0 ? avgWinUsd / avgLossUsd : 0

  return {
    deposits: decimalToNumber(depositsAgg._sum.amount),
    withdrawals: decimalToNumber(withdrawalsAgg._sum.amount),
    realizedPnl,
    tradeCount,
    wins,
    losses,
    bestTrade,
    worstTrade,
    avgWinUsd,
    avgLossUsd,
    expectancyUsd,
    payoffRatio,
  }
}

/**
 * Reconcile Portfolio.totalValue with the ledger when they drift.
 * Returns true when an update was written. This silently heals legacy
 * accounts that still carry the $10,000 paper-trading seed.
 */
export async function reconcilePortfolioTotalValue(
  userId: string,
  realizedEquity: number,
): Promise<boolean> {
  const portfolio = await prisma.portfolio.findUnique({
    where: { userId },
    select: { totalValue: true, pnl: true },
  })
  if (!portfolio) {
    await prisma.portfolio.create({
      data: { userId, totalValue: realizedEquity, pnl: 0 },
    })
    return true
  }
  const current = decimalToNumber(portfolio.totalValue)
  if (Math.abs(current - realizedEquity) < 0.005) return false
  try {
    await prisma.portfolio.update({
      where: { userId },
      data: { totalValue: realizedEquity },
    })
    return true
  } catch (e) {
    logger.warn(`[equity] reconcile failed for ${userId}: ${(e as Error).message}`)
    return false
  }
}
