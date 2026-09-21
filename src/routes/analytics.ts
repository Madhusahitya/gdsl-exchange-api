import { Router, Request, Response } from 'express'
import { prisma } from '@cryptoflow/db'
import { authenticateToken } from '../middleware/authenticateToken'
import { validate } from '../middleware/validate'
import { analyticsQuerySchema } from '../validators'
import { asyncHandler } from '../middleware/asyncHandler'

const router = Router()

function getStartDate(period: string): Date | undefined {
  if (period === 'all') return undefined
  const now = new Date()
  const days = period === '7d' ? 7 : period === '90d' ? 90 : 30
  now.setDate(now.getDate() - days)
  return now
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

router.get(
  '/summary',
  authenticateToken,
  validate(analyticsQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const { period } = (req as Request & { validated: { period: '7d' | '30d' | '90d' | 'all' } }).validated
    const startDate = getStartDate(period)

    const where = {
      userId,
      ...(startDate ? { createdAt: { gte: startDate } } : {}),
      status: 'CLOSED' as const,
    }

    const allTrades = await prisma.trade.findMany({ where, orderBy: { createdAt: 'asc' } })
    const totalTrades = allTrades.length
    const winning = allTrades.filter((t) => Number(t.pnl ?? 0) > 0)
    const losing = allTrades.filter((t) => Number(t.pnl ?? 0) < 0)
    const totalPnl = allTrades.reduce((s, t) => s + Number(t.pnl ?? 0), 0)

    const best = [...allTrades].sort((a, b) => Number(b.pnl ?? 0) - Number(a.pnl ?? 0))[0]
    const worst = [...allTrades].sort((a, b) => Number(a.pnl ?? 0) - Number(b.pnl ?? 0))[0]

    const byDay = new Map<string, number>()
    for (const t of allTrades) {
      const key = toDateKey(t.createdAt)
      byDay.set(key, (byDay.get(key) ?? 0) + Number(t.pnl ?? 0))
    }
    const dailyReturns = Array.from(byDay.values())
    const mean = dailyReturns.length ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0
    const variance = dailyReturns.length
      ? dailyReturns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / dailyReturns.length
      : 0
    const std = Math.sqrt(variance)
    const sharpeRatio = std === 0 ? 0 : (mean / std) * Math.sqrt(365)

    let peak = 0
    let equity = 0
    let maxDrawdown = 0
    for (const t of allTrades) {
      equity += Number(t.pnl ?? 0)
      peak = Math.max(peak, equity)
      if (peak > 0) {
        const dd = ((peak - equity) / peak) * 100
        maxDrawdown = Math.max(maxDrawdown, dd)
      }
    }

    const grossProfit = winning.reduce((s, t) => s + Number(t.pnl ?? 0), 0)
    const grossLoss = Math.abs(losing.reduce((s, t) => s + Number(t.pnl ?? 0), 0))

    res.json({
      totalTrades,
      winningTrades: winning.length,
      losingTrades: losing.length,
      winRate: totalTrades ? (winning.length / totalTrades) * 100 : 0,
      totalPnl,
      avgPnlPerTrade: totalTrades ? totalPnl / totalTrades : 0,
      bestTrade: best
        ? { pair: best.pair, pnl: Number(best.pnl ?? 0), date: best.createdAt }
        : null,
      worstTrade: worst
        ? { pair: worst.pair, pnl: Number(worst.pnl ?? 0), date: worst.createdAt }
        : null,
      avgHoldTime: 0,
      sharpeRatio,
      maxDrawdown,
      profitFactor: grossLoss === 0 ? (grossProfit > 0 ? grossProfit : 0) : grossProfit / grossLoss,
    })
  })
)

router.get(
  '/equity-curve',
  authenticateToken,
  validate(analyticsQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const { period } = (req as Request & { validated: { period: '7d' | '30d' | '90d' | 'all' } }).validated
    const startDate = getStartDate(period)

    const portfolio = await prisma.portfolio.findUnique({ where: { userId } })
    const where = {
      userId,
      ...(startDate ? { createdAt: { gte: startDate } } : {}),
      status: 'CLOSED' as const,
    }
    const allTrades = await prisma.trade.findMany({ where, orderBy: { createdAt: 'asc' } })

    const byDay = new Map<string, number>()
    for (const t of allTrades) {
      const key = toDateKey(t.createdAt)
      byDay.set(key, (byDay.get(key) ?? 0) + Number(t.pnl ?? 0))
    }

    const end = new Date()
    const begin = startDate ?? (allTrades[0]?.createdAt ?? end)
    const cursor = new Date(begin)
    const baseline = Number(portfolio?.totalValue ?? 0) - Number(portfolio?.pnl ?? 0)
    let equity = baseline
    const points: Array<{ date: string; portfolioValue: number; dailyPnl: number }> = []

    while (cursor <= end) {
      const key = toDateKey(cursor)
      const dailyPnl = byDay.get(key) ?? 0
      equity += dailyPnl
      points.push({ date: key, portfolioValue: equity, dailyPnl })
      cursor.setDate(cursor.getDate() + 1)
    }

    res.json(points)
  })
)

router.get(
  '/by-strategy',
  authenticateToken,
  validate(analyticsQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const { period } = (req as Request & { validated: { period: '7d' | '30d' | '90d' | 'all' } }).validated
    const startDate = getStartDate(period)
    const rows = await prisma.trade.findMany({
      where: {
        userId,
        ...(startDate ? { createdAt: { gte: startDate } } : {}),
        status: 'CLOSED',
      },
      include: { strategy: true },
    })

    const grouped = new Map<string, { strategyId: string; strategyName: string; values: number[] }>()
    for (const r of rows) {
      const item = grouped.get(r.strategyId) ?? {
        strategyId: r.strategyId,
        strategyName: r.strategy.name,
        values: [],
      }
      item.values.push(Number(r.pnl ?? 0))
      grouped.set(r.strategyId, item)
    }

    const result = Array.from(grouped.values()).map((g) => {
      const totalTrades = g.values.length
      const totalPnl = g.values.reduce((a, b) => a + b, 0)
      const wins = g.values.filter((v) => v > 0).length
      return {
        strategyId: g.strategyId,
        strategyName: g.strategyName,
        totalTrades,
        winRate: totalTrades ? (wins / totalTrades) * 100 : 0,
        totalPnl,
        avgPnl: totalTrades ? totalPnl / totalTrades : 0,
      }
    })

    res.json(result)
  })
)

router.get(
  '/by-pair',
  authenticateToken,
  validate(analyticsQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const { period } = (req as Request & { validated: { period: '7d' | '30d' | '90d' | 'all' } }).validated
    const startDate = getStartDate(period)
    const rows = await prisma.trade.findMany({
      where: {
        userId,
        ...(startDate ? { createdAt: { gte: startDate } } : {}),
        status: 'CLOSED',
      },
    })

    const grouped = new Map<string, number[]>()
    for (const r of rows) {
      const arr = grouped.get(r.pair) ?? []
      arr.push(Number(r.pnl ?? 0))
      grouped.set(r.pair, arr)
    }

    const result = Array.from(grouped.entries()).map(([pair, values]) => {
      const totalTrades = values.length
      const totalPnl = values.reduce((a, b) => a + b, 0)
      const wins = values.filter((v) => v > 0).length
      return {
        pair,
        totalTrades,
        winRate: totalTrades ? (wins / totalTrades) * 100 : 0,
        totalPnl,
        avgPnl: totalTrades ? totalPnl / totalTrades : 0,
      }
    })

    res.json(result)
  })
)

export default router
