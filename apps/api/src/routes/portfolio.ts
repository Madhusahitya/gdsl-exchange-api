import { Router, Request, Response } from 'express'
import { prisma } from '@cryptoflow/db'
import { authenticateToken } from '../middleware/authenticateToken'
import { asyncHandler } from '../middleware/asyncHandler'

const router = Router()

// GET /api/portfolio - Get user's portfolio with trade history
router.get('/', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId

  // Fetch portfolio
  const portfolio = await prisma.portfolio.findUnique({
    where: { userId },
  })

  if (!portfolio) {
    res.status(404).json({ error: 'Portfolio not found' })
    return
  }

  // Get trades from last 30 days grouped by date
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  const trades = await prisma.trade.findMany({
    where: {
      userId,
      createdAt: { gte: thirtyDaysAgo },
      status: 'CLOSED',
    },
    orderBy: { createdAt: 'asc' },
    select: {
      createdAt: true,
      pnl: true,
    },
  })

  // Group trades by date and calculate cumulative value
  const historyMap = new Map<string, number>()
  let runningValue = Number(portfolio.totalValue) - Number(portfolio.pnl)

  // Initialize with base value
  const startDate = new Date(thirtyDaysAgo)
  for (let i = 0; i <= 30; i++) {
    const date = new Date(startDate)
    date.setDate(startDate.getDate() + i)
    const dateStr = date.toISOString().split('T')[0]
    historyMap.set(dateStr, runningValue)
  }

  // Add PnL from trades to running value
  for (const trade of trades) {
    const dateStr = trade.createdAt.toISOString().split('T')[0]
    if (trade.pnl) {
      runningValue += Number(trade.pnl)
    }
    // Update this date and all future dates
    const tradeDate = new Date(dateStr)
    for (const [key] of historyMap) {
      const keyDate = new Date(key)
      if (keyDate >= tradeDate) {
        historyMap.set(key, runningValue)
      }
    }
  }

  // Convert map to array
  const history = Array.from(historyMap.entries())
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date))

  res.json({
    totalValue: Number(portfolio.totalValue),
    pnl: Number(portfolio.pnl),
    history,
  })
}))

export default router
