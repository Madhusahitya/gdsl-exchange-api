/**
 * Global paper trader — runs a single system-level paper trading bot
 * that doesn't belong to any real user. This allows the /performance
 * endpoints to show live stats without requiring a logged-in account.
 */
import bcrypt from 'bcryptjs'
import { prisma } from '@cryptoflow/db'
import { advancedBot } from './advancedBot'
import { logger } from '../../lib/logger'

export const GLOBAL_PAPER_EMAIL = 'system.tradingbot@cryptoflow.internal'
const GLOBAL_PAPER_PASSWORD = 'PaperBot#GlobalSystem1'

let globalUserId: string | null = null

export function getGlobalUserId(): string | null {
  return globalUserId
}

export async function startGlobalPaperTrader(): Promise<void> {
  try {
    // Upsert the strategy row that advancedBot references via FK
    await prisma.strategy.upsert({
      where: { id: 'advanced-ai' },
      update: {},
      create: {
        id:          'advanced-ai',
        name:        'Advanced AI (RL + Bayes)',
        description: 'Meta-policy: Bayesian ensemble + DQN RL model + order-book imbalance signals',
        riskLevel:   'HIGH',
      },
    })

    // Upsert system user
    let user = await prisma.user.findUnique({ where: { email: GLOBAL_PAPER_EMAIL } })
    if (!user) {
      const hash = await bcrypt.hash(GLOBAL_PAPER_PASSWORD, 10)
      user = await prisma.user.create({
        data: { email: GLOBAL_PAPER_EMAIL, passwordHash: hash },
      })
      logger.info('[globalPaperTrader] Created system paper trader user')
    }

    globalUserId = user.id

    // Ensure portfolio exists
    await prisma.portfolio.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id, totalValue: 10000, pnl: 0 },
    })

    if (advancedBot.isRunning(user.id)) {
      logger.info('[globalPaperTrader] Already running')
      return
    }

    await advancedBot.start(
      { userId: user.id, strategyId: 'advanced-ai', symbol: 'BTCUSDT', pair: 'BTC/USDT', mode: 'paper', orderSizeUsdtOverride: 500 },
      10000
    )
    logger.info(`[globalPaperTrader] Started paper bot for system user ${user.id}`)
  } catch (err) {
    logger.error({ err }, '[globalPaperTrader] Failed to start')
  }
}
