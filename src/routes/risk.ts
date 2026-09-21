import { Router, Request, Response } from 'express'
import { prisma } from '@cryptoflow/db'
import { authenticateToken } from '../middleware/authenticateToken'
import { asyncHandler } from '../middleware/asyncHandler'
import { validate } from '../middleware/validate'
import { updateRiskRuleSchema, riskEventsQuerySchema } from '../validators'
import { computeAutomationReadiness } from '../services/risk/readiness'

const router = Router()

router.use(authenticateToken)

router.get(
  '/rules',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const rule = await prisma.riskRule.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })
    res.json({
      rule: rule
        ? {
            id: rule.id,
            maxOrderNotional: rule.maxOrderNotional ? Number(rule.maxOrderNotional) : null,
            maxOpenNotional: rule.maxOpenNotional ? Number(rule.maxOpenNotional) : null,
            maxDailyLoss: rule.maxDailyLoss ? Number(rule.maxDailyLoss) : null,
            cooldownMinutes: rule.cooldownMinutes ?? 0,
            maxLosingStreak: rule.maxLosingStreak ?? 0,
            isEnabled: rule.isEnabled,
            updatedAt: rule.updatedAt.toISOString(),
          }
        : null,
    })
  })
)

router.put(
  '/rules',
  validate(updateRiskRuleSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const payload = (req as Request & { validated: {
      maxOrderNotional?: number | null
      maxOpenNotional?: number | null
      maxDailyLoss?: number | null
      cooldownMinutes?: number
      maxLosingStreak?: number
      isEnabled?: boolean
    } }).validated

    const existing = await prisma.riskRule.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })

    const normalized = {
      maxOrderNotional:
        payload.maxOrderNotional === undefined ? undefined : payload.maxOrderNotional,
      maxOpenNotional:
        payload.maxOpenNotional === undefined ? undefined : payload.maxOpenNotional,
      maxDailyLoss: payload.maxDailyLoss === undefined ? undefined : payload.maxDailyLoss,
      cooldownMinutes:
        payload.cooldownMinutes === undefined ? undefined : payload.cooldownMinutes,
      maxLosingStreak:
        payload.maxLosingStreak === undefined ? undefined : payload.maxLosingStreak,
      isEnabled: payload.isEnabled === undefined ? undefined : payload.isEnabled,
    }

    const rule = existing
      ? await prisma.riskRule.update({
          where: { id: existing.id },
          data: normalized,
        })
      : await prisma.riskRule.create({
          data: {
            userId,
            maxOrderNotional: normalized.maxOrderNotional ?? null,
            maxOpenNotional: normalized.maxOpenNotional ?? null,
            maxDailyLoss: normalized.maxDailyLoss ?? null,
            cooldownMinutes: normalized.cooldownMinutes ?? 0,
            maxLosingStreak: normalized.maxLosingStreak ?? 0,
            isEnabled: normalized.isEnabled ?? true,
          },
        })

    res.json({
      ok: true,
      rule: {
        id: rule.id,
        maxOrderNotional: rule.maxOrderNotional ? Number(rule.maxOrderNotional) : null,
        maxOpenNotional: rule.maxOpenNotional ? Number(rule.maxOpenNotional) : null,
        maxDailyLoss: rule.maxDailyLoss ? Number(rule.maxDailyLoss) : null,
        cooldownMinutes: rule.cooldownMinutes ?? 0,
        maxLosingStreak: rule.maxLosingStreak ?? 0,
        isEnabled: rule.isEnabled,
        updatedAt: rule.updatedAt.toISOString(),
      },
    })
  })
)

router.get(
  '/readiness',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const readiness = await computeAutomationReadiness(userId)
    res.json(readiness)
  })
)

router.get(
  '/events',
  validate(riskEventsQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const { limit } = (req as Request & { validated: { limit: number } }).validated
    const events = await prisma.riskEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })

    res.json({
      events: events.map((event) => ({
        id: event.id,
        kind: event.kind,
        severity: event.severity,
        message: event.message,
        metadata: event.metadata,
        createdAt: event.createdAt.toISOString(),
      })),
    })
  })
)

export default router
