/**
 * Clear paper-trading history for a user and reset portfolio to PAPER_STARTING_USD (default 10k).
 * Does not delete the User row, deposits, withdrawals, or market data (Kline).
 *
 * Usage (from repo root):
 *   npm run paper:reset
 *   npm run paper:reset -- --email=you@example.com
 *
 * Loads DATABASE_URL from apps/api/.env when present.
 */
import path from 'path'

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('dotenv').config({ path: path.join(__dirname, '../../../apps/api/.env') })
} catch {
  /* optional */
}

import { Prisma } from '@prisma/client'
import { prisma } from '../index'

/** Must match apps/api global paper dev user */
const DEFAULT_EMAIL = 'system.tradingbot@cryptoflow.internal'

const DEFAULT_START_USD = 10_000

function parseArgs(): { email: string; startUsd: number } {
  let email = process.env.RESET_PAPER_EMAIL ?? DEFAULT_EMAIL
  let startUsd = Number(process.env.PAPER_RESET_USD ?? DEFAULT_START_USD)

  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--email=')) email = a.slice('--email='.length).trim()
    else if (a.startsWith('--usd=')) {
      const n = parseFloat(a.slice('--usd='.length))
      if (Number.isFinite(n) && n > 0) startUsd = n
    }
  }

  return { email, startUsd }
}

async function main(): Promise<void> {
  const { email, startUsd } = parseArgs()

  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) {
    console.error(`No user with email: ${email}`)
    process.exit(1)
  }

  await prisma.$transaction(async (tx) => {
    await tx.executionEvent.deleteMany({ where: { userId: user.id } })
    await tx.tradingLog.deleteMany({ where: { userId: user.id } })
    await tx.botSession.deleteMany({ where: { userId: user.id } })
    await tx.trade.deleteMany({ where: { userId: user.id } })
    await tx.botRun.deleteMany({ where: { userId: user.id } })
    await tx.strategyPosition.deleteMany({ where: { userId: user.id } })
    await tx.positionLot.deleteMany({ where: { userId: user.id } })
    await tx.riskEvent.deleteMany({ where: { userId: user.id } })
    await tx.riskRule.deleteMany({ where: { userId: user.id } })
    await tx.signal.deleteMany({ where: { userId: user.id } })
    await tx.order.deleteMany({ where: { userId: user.id } })

    await tx.portfolio.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        totalValue: new Prisma.Decimal(startUsd),
        pnl: new Prisma.Decimal(0),
      },
      update: {
        totalValue: new Prisma.Decimal(startUsd),
        pnl: new Prisma.Decimal(0),
      },
    })
  })

  console.log(`Paper state reset for ${email}: portfolio = $${startUsd.toFixed(2)} USDT, PnL = 0, sessions/trades/logs cleared.`)
  console.log('Stop the API dev server if the bot is running, then start the bot again from the UI or POST /api/engine/start.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
