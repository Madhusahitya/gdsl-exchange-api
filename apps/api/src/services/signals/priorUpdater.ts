/**
 * Prior updater: looks at Signal rows that have no outcome yet,
 * checks if the bar after the signal was bullish or bearish,
 * then calls updatePriors to adjust Beta distributions.
 *
 * Run as a cron, e.g., every hour.
 */
import { prisma } from '@cryptoflow/db'
import { logger } from '../../lib/logger'
import { updatePriors, Direction } from './bayesianEnsemble'

export async function runPriorUpdate() {
  // Find signals that were created > 1h ago with no outcome yet
  const cutoff = new Date(Date.now() - 60 * 60 * 1000)

  const unresolved = await prisma.signal.findMany({
    where: {
      outcome: null,
      ts: { lt: cutoff },
    },
    take: 500,
    orderBy: { ts: 'asc' },
  })

  if (unresolved.length === 0) return

  let updated = 0

  for (const sig of unresolved) {
    try {
      // Find the kline bar that closed after this signal
      const nextBar = await prisma.kline.findFirst({
        where: {
          symbol:   sig.symbol,
          interval: '1h',
          openTime: { gt: sig.ts },
        },
        orderBy: { openTime: 'asc' },
        select: { open: true, close: true },
      })

      if (!nextBar) continue

      const actualUp = Number(nextBar.close) >= Number(nextBar.open)
      const retPct = (Number(nextBar.close) - Number(nextBar.open)) / Number(nextBar.open)

      // Update the Signal row with the outcome
      await prisma.signal.update({
        where: { id: sig.id },
        data: {
          outcome:   actualUp ? 'WIN' : 'LOSS',
          returnPct: retPct,
        },
      })

      // Reconstruct components from rationale JSON if present
      const rationale = sig.rationale as Record<string, string> | null
      if (rationale) {
        await updatePriors(
          sig.symbol,
          '1h',
          rationale as Record<string, Direction>,
          actualUp
        )
      }

      updated++
    } catch (err) {
      logger.warn({ err, signalId: sig.id }, '[priorUpdater] failed to update signal')
    }
  }

  if (updated > 0) {
    logger.info(`[priorUpdater] Updated ${updated} signal outcomes and Bayes priors`)
  }
}
