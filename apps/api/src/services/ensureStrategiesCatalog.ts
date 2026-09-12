import { prisma } from '@cryptoflow/db'
import { logger } from '../lib/logger'

/**
 * Upsert default strategies so GET /api/strategies never returns an empty catalog on a fresh DB.
 * Safe to run on every API boot (idempotent).
 */
export async function ensureStrategiesCatalog(): Promise<void> {
  const defaults = [
    {
      name: 'Trend-Following',
      description:
        'Follows the prevailing market trend using moving averages and momentum indicators.',
      riskLevel: 'LOW' as const,
    },
    {
      name: 'Reversal',
      description: 'Identifies potential price reversals at key support and resistance levels.',
      riskLevel: 'MEDIUM' as const,
    },
    {
      name: 'Momentum',
      description: 'Exploits short-term price momentum with aggressive entry and exit signals.',
      riskLevel: 'HIGH' as const,
    },
    {
      name: 'SMA Crossover',
      description: 'Simple moving average crossover signals (paper/live bot engine default style).',
      riskLevel: 'MEDIUM' as const,
    },
  ]

  for (const s of defaults) {
    await prisma.strategy.upsert({
      where: { name: s.name },
      create: s,
      update: { description: s.description, riskLevel: s.riskLevel },
    })
  }

  await prisma.strategy.upsert({
    where: { id: 'advanced-ai' },
    update: {},
    create: {
      id: 'advanced-ai',
      name: 'Advanced AI (RL + Bayes)',
      description: 'Meta-policy: Bayesian ensemble + DQN RL model + order-book imbalance signals',
      riskLevel: 'HIGH',
    },
  })

  logger.info('[strategies] Catalog ensured (defaults + advanced-ai)')
}
