/**
 * Performance journal for DEX Jupiter SOL trades — win rate, PnL, best/worst tokens.
 */
import { TradeStatus, prisma } from '@cryptoflow/db'
import { displayNetRoundTripPnl, JUPITER_DEX_STRATEGY_NAME } from '../../lib/roundTripPnl'
import { JUPITER_STRATEGY_NAME } from './jupiterSwapService'

export type JupiterJournalTrade = {
  id: string
  pair: string
  baseSymbol: string
  entryPrice: number
  exitPrice: number
  allocationUsd: number
  pnlUsd: number
  pnlPct: number
  holdMinutes: number
  closedAt: string
}

export type JupiterJournalTokenStat = {
  baseSymbol: string
  trades: number
  wins: number
  winRatePct: number
  totalPnlUsd: number
}

export type JupiterJournal = {
  totalTrades: number
  wins: number
  losses: number
  breakeven: number
  winRatePct: number
  totalPnlUsd: number
  avgPnlUsd: number
  avgHoldMinutes: number | null
  bestTrade: { pair: string; pnlUsd: number } | null
  worstTrade: { pair: string; pnlUsd: number } | null
  topTokens: JupiterJournalTokenStat[]
  recentClosed: JupiterJournalTrade[]
  updatedAt: string
}

async function jupiterStrategyId(): Promise<string | null> {
  const s = await prisma.strategy.findFirst({
    where: { name: JUPITER_STRATEGY_NAME },
    select: { id: true },
  })
  return s?.id ?? null
}

export async function getJupiterTradeJournal(userId: string, limit = 20): Promise<JupiterJournal> {
  const strategyId = await jupiterStrategyId()
  if (!strategyId) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      winRatePct: 0,
      totalPnlUsd: 0,
      avgPnlUsd: 0,
      avgHoldMinutes: null,
      bestTrade: null,
      worstTrade: null,
      topTokens: [],
      recentClosed: [],
      updatedAt: new Date().toISOString(),
    }
  }

  const closed = await prisma.trade.findMany({
    where: {
      userId,
      strategyId,
      status: TradeStatus.CLOSED,
      exitPrice: { not: null },
      pnl: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: {
      id: true,
      pair: true,
      entryPrice: true,
      exitPrice: true,
      allocationUsd: true,
      pnl: true,
      createdAt: true,
    },
  })

  const recentClosed: JupiterJournalTrade[] = []
  const byToken = new Map<string, { trades: number; wins: number; pnl: number }>()
  let wins = 0
  let losses = 0
  let breakeven = 0
  let totalPnl = 0
  let best: { pair: string; pnlUsd: number } | null = null
  let worst: { pair: string; pnlUsd: number } | null = null

  for (const t of closed) {
    const entry = Number(t.entryPrice)
    const exit = Number(t.exitPrice)
    const alloc = Number(t.allocationUsd ?? 0)
    const storedPnl = Number(t.pnl ?? 0)
    const pnl =
      displayNetRoundTripPnl({
        pnl: storedPnl,
        allocationUsd: t.allocationUsd,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        strategyName: JUPITER_DEX_STRATEGY_NAME,
      }) ?? storedPnl
    if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(exit)) continue

    totalPnl += pnl
    if (pnl > 0.001) wins++
    else if (pnl < -0.001) losses++
    else breakeven++

    if (!best || pnl > best.pnlUsd) best = { pair: t.pair, pnlUsd: Math.round(pnl * 100) / 100 }
    if (!worst || pnl < worst.pnlUsd) worst = { pair: t.pair, pnlUsd: Math.round(pnl * 100) / 100 }

    const base = t.pair.split('/')[0]?.toUpperCase() ?? t.pair
    const agg = byToken.get(base) ?? { trades: 0, wins: 0, pnl: 0 }
    agg.trades++
    if (pnl > 0) agg.wins++
    agg.pnl += pnl
    byToken.set(base, agg)

    if (recentClosed.length < limit) {
      recentClosed.push({
        id: t.id,
        pair: t.pair,
        baseSymbol: base,
        entryPrice: entry,
        exitPrice: exit,
        allocationUsd: alloc,
        pnlUsd: Math.round(pnl * 100) / 100,
        pnlPct: alloc > 0 ? Math.round((pnl / alloc) * 10_000) / 100 : 0,
        holdMinutes: 0,
        closedAt: t.createdAt.toISOString(),
      })
    }
  }

  const totalTrades = wins + losses + breakeven
  const topTokens = [...byToken.entries()]
    .map(([baseSymbol, s]) => ({
      baseSymbol,
      trades: s.trades,
      wins: s.wins,
      winRatePct: s.trades > 0 ? Math.round((s.wins / s.trades) * 10_000) / 100 : 0,
      totalPnlUsd: Math.round(s.pnl * 100) / 100,
    }))
    .sort((a, b) => b.totalPnlUsd - a.totalPnlUsd)
    .slice(0, 8)

  return {
    totalTrades,
    wins,
    losses,
    breakeven,
    winRatePct: totalTrades > 0 ? Math.round((wins / totalTrades) * 10_000) / 100 : 0,
    totalPnlUsd: Math.round(totalPnl * 100) / 100,
    avgPnlUsd: totalTrades > 0 ? Math.round((totalPnl / totalTrades) * 100) / 100 : 0,
    avgHoldMinutes: null,
    bestTrade: best,
    worstTrade: worst,
    topTokens,
    recentClosed,
    updatedAt: new Date().toISOString(),
  }
}
