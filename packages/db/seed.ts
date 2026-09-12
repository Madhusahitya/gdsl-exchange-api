import { prisma } from './index'
import bcrypt from 'bcryptjs'

async function main() {
  console.log('Seeding database...')

  // Clean up existing seed data
  await prisma.trade.deleteMany()
  await prisma.botSession.deleteMany()
  await prisma.portfolio.deleteMany()
  await prisma.strategy.deleteMany()
  await prisma.user.deleteMany()

  // 1. Create test user
  const passwordHash = await bcrypt.hash('password123', 10)
  const user = await prisma.user.create({
    data: {
      email: 'test@cryptoflow.com',
      passwordHash,
      balance: 10000,
    },
  })
  console.log('Created user:', user.email)

  // 2. Create portfolio
  const portfolio = await prisma.portfolio.create({
    data: {
      userId: user.id,
      totalValue: 10000,
      pnl: 250,
    },
  })
  console.log('Created portfolio: totalValue =', portfolio.totalValue.toString())

  // 3. Create strategies
  const [trend, reversal, momentum] = await Promise.all([
    prisma.strategy.create({
      data: {
        name: 'Trend-Following',
        description: 'Follows the prevailing market trend using moving averages and momentum indicators.',
        riskLevel: 'LOW',
      },
    }),
    prisma.strategy.create({
      data: {
        name: 'Reversal',
        description: 'Identifies potential price reversals at key support and resistance levels.',
        riskLevel: 'MEDIUM',
      },
    }),
    prisma.strategy.create({
      data: {
        name: 'Momentum',
        description: 'Exploits short-term price momentum with aggressive entry and exit signals.',
        riskLevel: 'HIGH',
      },
    }),
  ])
  console.log('Created strategies:', [trend.name, reversal.name, momentum.name].join(', '))

  // 4. Create demo trades
  const trades = [
    {
      pair: 'BTC/USDT',
      strategyId: trend.id,
      entryPrice: 62000,
      exitPrice: 64500,
      get pnl() { return this.exitPrice - this.entryPrice },
      status: 'CLOSED' as const,
    },
    {
      pair: 'ETH/USDT',
      strategyId: reversal.id,
      entryPrice: 3100,
      exitPrice: 2980,
      get pnl() { return this.exitPrice - this.entryPrice },
      status: 'CLOSED' as const,
    },
    {
      pair: 'SOL/USDT',
      strategyId: momentum.id,
      entryPrice: 145,
      exitPrice: null,
      pnl: null,
      status: 'OPEN' as const,
    },
  ]

  for (const trade of trades) {
    const created = await prisma.trade.create({
      data: {
        userId: user.id,
        strategyId: trade.strategyId,
        pair: trade.pair,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice ?? undefined,
        pnl: trade.pnl ?? undefined,
        status: trade.status,
      },
    })
    console.log(`Created trade: ${created.pair} [${created.status}]`)
  }

  console.log('\nSeed complete.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
