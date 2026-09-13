import { Router, Request, Response } from 'express'
import { prisma, ExecutionEventType } from '@cryptoflow/db'
import { authenticateToken } from '../middleware/authenticateToken'
import { paperTradingBot } from '@cryptoflow/bot'
import { liveTradingBot } from '../services/bot/liveTradingBot'
import { validate } from '../middleware/validate'
import { asyncHandler } from '../middleware/asyncHandler'
import { startBotSchema } from '../validators'

const router = Router()

router.post('/start', authenticateToken, validate(startBotSchema), asyncHandler(async (req: Request, res: Response) => {
  res.status(410).json({
    error: 'Legacy bot route is disabled. Start automation via POST /api/engine/start with mode=live.',
  })
}))

router.post('/stop', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const session = await prisma.botSession.findFirst({ where: { userId, isActive: true } })
  if (!session) {
    res.status(404).json({ error: 'No active bot session found' })
    return
  }

  let stats = { sessionDuration: 0, totalTrades: 0 }
  try {
    if (paperTradingBot.isRunning(userId)) {
      stats = await paperTradingBot.stop(userId)
    } else if (liveTradingBot.isRunning(userId)) {
      stats = await liveTradingBot.stop(userId)
    }
  } catch {
    /* best-effort stop */
  }

  await prisma.botSession.update({ where: { id: session.id }, data: { isActive: false, stoppedAt: new Date() } })
  const run = await prisma.botRun.findFirst({ where: { userId, status: 'RUNNING' }, orderBy: { startedAt: 'desc' } })
  if (run) {
    await prisma.botRun.update({ where: { id: run.id }, data: { status: 'STOPPED', stoppedAt: new Date(), stopReason: 'manual_stop' } })
    await prisma.executionEvent.create({
      data: { userId, botRunId: run.id, eventType: ExecutionEventType.BOT_STOPPED, payload: stats },
    })
  }
  res.json({ message: 'Bot stopped', sessionId: session.id, sessionDuration: stats.sessionDuration, totalTrades: stats.totalTrades })
}))

router.get('/status', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const session = await prisma.botSession.findFirst({
    where: { userId, isActive: true },
    include: { strategy: { select: { name: true, riskLevel: true } } },
  })

  if (!session) {
    res.json({ isActive: false })
    return
  }

  const tradeCount = liveTradingBot.isRunning(userId)
    ? await prisma.order.count({ where: { userId, createdAt: { gte: session.startedAt } } })
    : await prisma.trade.count({ where: { userId, createdAt: { gte: session.startedAt } } })
  const runningDuration = Math.floor((Date.now() - session.startedAt.getTime()) / 1000)

  res.json({
    isActive: true,
    sessionId: session.id,
    strategyId: session.strategyId,
    strategyName: session.strategy.name,
    riskLevel: session.strategy.riskLevel,
    startedAt: session.startedAt,
    runningDuration,
    tradeCount,
  })
}))

export default router
