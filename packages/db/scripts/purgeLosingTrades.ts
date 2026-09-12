/**
 * Analyze and optionally remove closed trades with negative PnL (demo cleanup).
 * Profit overview and trade log both read from Trade rows — removing losers
 * keeps them in sync automatically.
 *
 * Usage (from repo root):
 *   npm run purge:losing-trades -- --email=you@example.com --dry-run
 *   npm run purge:losing-trades -- --email=you@example.com --confirm
 */
import path from 'path'

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('dotenv').config({ path: path.join(__dirname, '../../../apps/api/.env') })
} catch {
  /* optional */
}

import { Prisma, TradeStatus } from '@prisma/client'
import { prisma } from '../index'

const DEFAULT_EMAIL = 'godsland100@godslandx.internal'

const MAJORS = new Set(['SOL', 'BTC', 'ETH', 'WBTC', 'WETH', 'JUP', 'BNB', 'XRP'])

function parseArgs(): { email: string; dryRun: boolean } {
  let email = process.env.PURGE_EMAIL ?? DEFAULT_EMAIL
  let dryRun = true
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--email=')) email = a.slice('--email='.length).trim()
    else if (a === '--confirm') dryRun = false
    else if (a === '--dry-run') dryRun = true
  }
  return { email, dryRun }
}

function baseSymbol(pair: string): string {
  return pair.replace(/\/USDT$/i, '').replace(/USDT$/i, '').toUpperCase()
}

type LossReason =
  | 'meme_alt_exposure'
  | 'large_pct_loss'
  | 'small_notional_slippage'
  | 'moderate_loss'
  | 'unknown'

function classifyLoss(trade: {
  pair: string
  pnl: Prisma.Decimal | null
  allocationUsd: Prisma.Decimal | null
  entryPrice: Prisma.Decimal
  exitPrice: Prisma.Decimal | null
}): { reason: LossReason; detail: string } {
  const pnl = Number(trade.pnl ?? 0)
  const alloc = Number(trade.allocationUsd ?? 0)
  const entry = Number(trade.entryPrice)
  const exit = Number(trade.exitPrice ?? 0)
  const base = baseSymbol(trade.pair)
  const pct =
    entry > 0 && exit > 0 ? ((exit - entry) / entry) * 100 : alloc > 0 ? (pnl / alloc) * 100 : 0

  if (!MAJORS.has(base)) {
    return {
      reason: 'meme_alt_exposure',
      detail: `${base} is not a tier-1 major — Super Machine scanned Jupiter trending memes/alts`,
    }
  }
  if (pct <= -8) {
    return {
      reason: 'large_pct_loss',
      detail: `Round-trip down ~${Math.abs(pct).toFixed(1)}% — likely chased momentum or stop hit`,
    }
  }
  if (alloc > 0 && alloc < 15 && pnl > -2) {
    return {
      reason: 'small_notional_slippage',
      detail: `Small $${alloc.toFixed(2)} lot — gas/fees/spread can turn marginal entries red`,
    }
  }
  if (pct <= -3) {
    return {
      reason: 'moderate_loss',
      detail: `Down ~${Math.abs(pct).toFixed(1)}% — council may have approved a weak setup`,
    }
  }
  return { reason: 'unknown', detail: 'Review council decision + entry timing manually' }
}

async function main(): Promise<void> {
  const { email, dryRun } = parseArgs()
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) {
    console.error(`No user: ${email}`)
    process.exit(1)
  }

  const losers = await prisma.trade.findMany({
    where: {
      userId: user.id,
      status: TradeStatus.CLOSED,
      pnl: { lt: 0 },
      exitPrice: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      pair: true,
      pnl: true,
      allocationUsd: true,
      entryPrice: true,
      exitPrice: true,
      createdAt: true,
      strategy: { select: { name: true } },
    },
  })

  if (losers.length === 0) {
    console.log(`No losing closed trades for ${email}.`)
    return
  }

  const totalLoss = losers.reduce((s, t) => s + Number(t.pnl), 0)
  console.log(`\n=== Losing trades (${losers.length}) · total PnL ${totalLoss.toFixed(4)} USD ===\n`)

  const byReason: Record<LossReason, number> = {
    meme_alt_exposure: 0,
    large_pct_loss: 0,
    small_notional_slippage: 0,
    moderate_loss: 0,
    unknown: 0,
  }

  for (const t of losers) {
    const { reason, detail } = classifyLoss(t)
    byReason[reason]++
    console.log(
      [
        t.createdAt.toISOString().slice(0, 16),
        t.strategy?.name ?? '?',
        t.pair.padEnd(12),
        `$${Number(t.pnl).toFixed(4)}`,
        reason,
        detail,
      ].join(' · '),
    )
  }

  console.log('\n--- Summary by root cause ---')
  for (const [k, v] of Object.entries(byReason)) {
    if (v > 0) console.log(`  ${k}: ${v}`)
  }

  console.log('\n--- Recommended fixes (code) ---')
  console.log('  1. Prefer SOL/BTC/ETH in Super Machine scanner (tier-1 bias)')
  console.log('  2. Council core agents need ≥90% confidence to vote BUY')
  console.log('  3. Block entries on +8% 5m / +20% 1h pumps (already partially gated)')
  console.log('  4. Raise minimum consensus bar to ~63%')

  if (dryRun) {
    console.log('\nDry run — pass --confirm to delete these trades from the log.')
    return
  }

  const ids = losers.map((t) => t.id)
  const deleted = await prisma.trade.deleteMany({ where: { id: { in: ids } } })

  console.log(`\nDeleted ${deleted.count} losing trade(s). Profit overview will match on next dashboard refresh.`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
