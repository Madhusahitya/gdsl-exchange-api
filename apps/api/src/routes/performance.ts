/**
 * Live performance route — global paper trading monitor.
 * All endpoints are PUBLIC — no auth required.
 *
 * GET /performance/live       core stats + signal accuracy + position
 * GET /performance/models     model version history
 * GET /performance/recent     last N trades
 */
import { Router, Request, Response } from 'express'
import { prisma } from '@cryptoflow/db'
import { asyncHandler } from '../middleware/asyncHandler'
import { getGlobalUserId } from '../services/bot/globalPaperTrader'

const router = Router()

// ─── helpers ─────────────────────────────────────────────────────────────────

function streak(trades: { pnl: number | null }[]): number {
  if (!trades.length) return 0
  const last = trades[trades.length - 1]
  const sign = Number(last.pnl ?? 0) >= 0 ? 1 : -1
  let count = 0
  for (let i = trades.length - 1; i >= 0; i--) {
    const p = Number(trades[i].pnl ?? 0)
    if (sign === 1 && p >= 0) count++
    else if (sign === -1 && p < 0) count++
    else break
  }
  return sign * count  // positive = win streak, negative = loss streak
}

function rollingSharp(trades: { pnl: number | null }[]): number {
  if (trades.length < 3) return 0
  const rets = trades.map((t) => Number(t.pnl ?? 0))
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  const std  = Math.sqrt(rets.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / rets.length)
  return std === 0 ? 0 : (mean / std) * Math.sqrt(365)
}

// ─── GET /performance/live ────────────────────────────────────────────────────

router.get(
  '/live',
  asyncHandler(async (_req: Request, res: Response) => {
    const userId = getGlobalUserId()
    if (!userId) {
      return res.json({
        summary: { totalTrades: 0, winRate: 0, totalPnl: 0, avgPnl: 0, profitFactor: 0, sharpe: 0, maxDrawdown: 0, streak: 0, winsCount: 0, lossesCount: 0 },
        position: null, signalAccuracy: [], recentSignals: [], model: null,
      })
    }

    // All closed paper trades
    const trades = await prisma.trade.findMany({
      where: { userId, status: 'CLOSED' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, pair: true, pnl: true, entryPrice: true, exitPrice: true, createdAt: true },
    })

    const numTrades = trades.map((t) => ({ ...t, pnl: t.pnl !== null ? Number(t.pnl) : null }))
    const total   = numTrades.length
    const wins    = numTrades.filter((t) => (t.pnl ?? 0) > 0)
    const losses  = numTrades.filter((t) => (t.pnl ?? 0) < 0)
    const totalPnl= numTrades.reduce((s, t) => s + (t.pnl ?? 0), 0)
    const grossP  = wins.reduce((s, t) => s + (t.pnl ?? 0), 0)
    const grossL  = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0))

    // Current open position
    const openTrade = await prisma.trade.findFirst({
      where: { userId, status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, pair: true, entryPrice: true, createdAt: true },
    })

    // Signal accuracy from BayesPrior
    const priors = await prisma.bayesPrior.findMany({
      where: { interval: '1h' },
      select: { signalSource: true, symbol: true, alphaUp: true, betaUp: true, alphaDown: true, betaDown: true },
    })

    const sourceMap = new Map<string, { correct: number; total: number }>()
    for (const p of priors) {
      const existing = sourceMap.get(p.signalSource) ?? { correct: 0, total: 0 }
      existing.correct += p.alphaUp + p.alphaDown - 2
      existing.total   += p.alphaUp + p.betaUp + p.alphaDown + p.betaDown - 4
      sourceMap.set(p.signalSource, existing)
    }
    const signalAccuracy = Array.from(sourceMap.entries())
      .map(([source, { correct, total }]) => ({
        source,
        accuracy: total > 0 ? (correct / total) * 100 : 50,
        observations: total,
      }))
      .filter((s) => s.observations > 10)
      .sort((a, b) => b.accuracy - a.accuracy)

    // Last 10 meta-signals
    const recentSignals = await prisma.signal.findMany({
      where: { userId, source: 'meta' },
      orderBy: { ts: 'desc' },
      take: 10,
      select: { id: true, symbol: true, direction: true, confidence: true, outcome: true, ts: true, rationale: true },
    })

    // RL champion
    const champion = await prisma.modelVersion.findFirst({
      where: { status: 'champion' },
      orderBy: { promotedAt: 'desc' },
      select: { modelId: true, sharpe: true, winRate: true, maxDrawdown: true, promotedAt: true },
    })

    // Max drawdown
    let peak = 0; let eq = 0; let maxDD = 0
    for (const t of numTrades) {
      eq += (t.pnl ?? 0)
      peak = Math.max(peak, eq)
      if (peak > 0) maxDD = Math.max(maxDD, ((peak - eq) / peak) * 100)
    }

    res.json({
      summary: {
        totalTrades:   total,
        winRate:       total ? (wins.length / total) * 100 : 0,
        totalPnl,
        avgPnl:        total ? totalPnl / total : 0,
        profitFactor:  grossL === 0 ? (grossP > 0 ? grossP : 0) : grossP / grossL,
        sharpe:        rollingSharp(numTrades),
        maxDrawdown:   maxDD,
        streak:        streak(numTrades),
        winsCount:     wins.length,
        lossesCount:   losses.length,
      },
      position: openTrade ? {
        pair:       openTrade.pair,
        entryPrice: Number(openTrade.entryPrice),
        since:      openTrade.createdAt,
      } : null,
      signalAccuracy,
      recentSignals,
      model: champion,
    })
  })
)

// ─── GET /performance/models ──────────────────────────────────────────────────

router.get(
  '/models',
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = await prisma.modelVersion.findMany({
      orderBy: { trainedAt: 'desc' },
      take: 20,
    })
    res.json(rows)
  })
)

// ─── GET /performance/recent ──────────────────────────────────────────────────

router.get(
  '/recent',
  asyncHandler(async (_req: Request, res: Response) => {
    const userId = getGlobalUserId()
    if (!userId) return res.json([])
    const trades = await prisma.trade.findMany({
      where: { userId, status: 'CLOSED' },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, pair: true, pnl: true, entryPrice: true, exitPrice: true, createdAt: true },
    })
    res.json(trades)
  })
)

export default router
