import { Router, Request, Response } from 'express'
import { prisma } from '@cryptoflow/db'
import { authenticateToken } from '../middleware/authenticateToken'
import { validate } from '../middleware/validate'
import { asyncHandler } from '../middleware/asyncHandler'
import { referralApplySchema } from '../validators'
import { getJupiterReferralStats } from '../services/dex/jupiterReferralVolumeService'

const router = Router()

const REFEREE_BONUS = 5
const REFERRER_BONUS = 5

router.get('/status', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { referralCode: true, referredById: true, trialBalance: true },
  })
  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }

  const [rewardSum, referralCount, jupiterStats] = await Promise.all([
    prisma.referralReward.aggregate({
      where: { userId },
      _sum: { amount: true },
    }),
    prisma.user.count({ where: { referredById: userId } }),
    getJupiterReferralStats(userId),
  ])

  res.json({
    referralCode: user.referralCode,
    hasAppliedReferral: Boolean(user.referredById),
    totalRewards: Number(rewardSum._sum.amount ?? 0),
    referralCount,
    trialBalance: Number(user.trialBalance),
    jupiterReferralEarningsUsd: jupiterStats.jupiterReferralEarningsUsd,
    jupiterVolumeReferredUsd: jupiterStats.jupiterVolumeReferredUsd,
    jupiterReferralTrades: jupiterStats.jupiterReferralTrades,
  })
}))

router.post('/apply', authenticateToken, validate(referralApplySchema), asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const { code } = (req as Request & { validated: { code: string } }).validated

  const self = await prisma.user.findUnique({
    where: { id: userId },
    select: { referredById: true, referralCode: true },
  })
  if (!self) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  if (self.referredById) {
    res.status(400).json({ error: 'Referral code already applied' })
    return
  }
  if (self.referralCode && code === self.referralCode) {
    res.status(400).json({ error: 'Cannot use your own code' })
    return
  }

  const referrer = await prisma.user.findUnique({
    where: { referralCode: code },
    select: { id: true },
  })
  if (!referrer || referrer.id === userId) {
    res.status(400).json({ error: 'Invalid referral code' })
    return
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        referredById: referrer.id,
        trialBalance: { increment: REFEREE_BONUS },
      },
    }),
    prisma.user.update({
      where: { id: referrer.id },
      data: { trialBalance: { increment: REFERRER_BONUS } },
    }),
    prisma.referralReward.create({
      data: {
        userId: referrer.id,
        amount: REFERRER_BONUS,
        reason: 'referral_signup_bonus',
      },
    }),
    prisma.referralReward.create({
      data: {
        userId,
        amount: REFEREE_BONUS,
        reason: 'referral_welcome_bonus',
      },
    }),
  ])

  res.json({ ok: true, refereeBonus: REFEREE_BONUS, referrerBonus: REFERRER_BONUS })
}))

export default router
