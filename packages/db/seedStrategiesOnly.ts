/**
 * Safe to run anytime: upserts default bot strategies without deleting users or trades.
 * Run from repo root: npm run db:seed:strategies
 * Loads DATABASE_URL from apps/api/.env when present (same as local API).
 */
import path from 'path'
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('dotenv').config({ path: path.join(__dirname, '../../.env') })
} catch {
  /* dotenv optional */
}

import { prisma } from './index'

const DEFAULT_STRATEGIES = [
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

async function main() {
  for (const s of DEFAULT_STRATEGIES) {
    await prisma.strategy.upsert({
      where: { name: s.name },
      create: s,
      update: { description: s.description, riskLevel: s.riskLevel },
    })
    console.log('Strategy OK:', s.name)
  }
  console.log('Done — strategies table populated.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
