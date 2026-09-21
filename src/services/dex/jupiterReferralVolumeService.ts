/**
 * Credits referrers a small share of referred users' Jupiter BUY volume.
 */
import { prisma } from '@cryptoflow/db'
import { logger } from '../../lib/logger'

/** 0.1% of notional — platform keeps the rest; aligns with Jupiter referral flywheel. */
const REFERRAL_VOLUME_BPS = 10
const MIN_REWARD_USD = 0.01

export async function maybeCreditJupiterReferralVolume(
  userId: string,
  notionalUsd: number,
  side: 'BUY' | 'SELL',
): Promise<void> {
  if (side !== 'BUY' || !Number.isFinite(notionalUsd) || notionalUsd <= 0) return

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { referredById: true },
  })
  if (!user?.referredById) return

  const rawReward = (notionalUsd * REFERRAL_VOLUME_BPS) / 10_000
  const reward = Math.round(Math.max(MIN_REWARD_USD, rawReward) * 1e6) / 1e6
  if (reward <= 0) return

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.referredById },
      data: { trialBalance: { increment: reward } },
    }),
    prisma.referralReward.create({
      data: {
        userId: user.referredById,
        amount: reward,
        reason: `jupiter_volume_share:${notionalUsd.toFixed(2)}`,
      },
    }),
  ])

  logger.info(
    { referrerId: user.referredById, refereeId: userId, notionalUsd, reward },
    '[jupiter-referral] volume share credited',
  )
}

export async function getJupiterReferralStats(userId: string): Promise<{
  jupiterReferralEarningsUsd: number
  jupiterVolumeReferredUsd: number
  jupiterReferralTrades: number
}> {
  const rewards = await prisma.referralReward.findMany({
    where: { userId, reason: { startsWith: 'jupiter_volume_share:' } },
    select: { amount: true, reason: true },
  })

  let jupiterReferralEarningsUsd = 0
  let jupiterVolumeReferredUsd = 0

  for (const r of rewards) {
    jupiterReferralEarningsUsd += Number(r.amount)
    const match = /^jupiter_volume_share:([\d.]+)$/.exec(r.reason)
    if (match) jupiterVolumeReferredUsd += Number.parseFloat(match[1]) || 0
  }

  return {
    jupiterReferralEarningsUsd: Math.round(jupiterReferralEarningsUsd * 1e6) / 1e6,
    jupiterVolumeReferredUsd: Math.round(jupiterVolumeReferredUsd * 1e2) / 1e2,
    jupiterReferralTrades: rewards.length,
  }
}
