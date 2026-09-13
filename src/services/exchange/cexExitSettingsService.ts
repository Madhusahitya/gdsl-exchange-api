/**
 * Per-user take-profit / stop-loss for the Binance CEX book (live bot + Auto Binance).
 *
 * Backed by `CexExitConfig` so a redeploy cannot silently reset a user's stop-loss.
 * A short-lived cache keeps the 5s live-bot tick off the database. Additive — does
 * not touch Jupiter exits.
 */
import { prisma } from '@cryptoflow/db'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'

export type CexExitSettings = {
  enabled: boolean
  takeProfitPct: number
  stopLossPct: number
  /** At TP, sell only the profit slice and keep the runner (full close if slice is under Binance min order). */
  profitSkim: boolean
  trailingStop: boolean
  /** Trailing arms only once price is this % above entry (keeps it out of fee noise). */
  trailingActivationPct: number
  /** Once armed, exit when price falls this % below the peak. */
  trailingDeltaPct: number
}

const CACHE_TTL_MS = 30_000

function clampPct(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

export function cexExitDefaults(): CexExitSettings {
  return {
    enabled: true,
    takeProfitPct: clampPct(env.CEX_LIVE_TAKE_PROFIT_PCT, 0.2, 50),
    stopLossPct: clampPct(env.CEX_LIVE_STOP_LOSS_PCT, 0.2, 50),
    profitSkim: false,
    trailingStop: false,
    trailingActivationPct: 0.8,
    trailingDeltaPct: 0.4,
  }
}

const cache = new Map<string, { at: number; settings: CexExitSettings }>()

export async function getCexExitSettings(userId: string): Promise<CexExitSettings> {
  const hit = cache.get(userId)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.settings

  try {
    const row = await prisma.cexExitConfig.findUnique({ where: { userId } })
    const settings: CexExitSettings = row
      ? {
          enabled: row.enabled,
          takeProfitPct: clampPct(Number(row.takeProfitPct), 0.2, 50),
          stopLossPct: clampPct(Number(row.stopLossPct), 0.2, 50),
          profitSkim: row.profitSkim ?? false,
          trailingStop: row.trailingStop ?? false,
          trailingActivationPct: clampPct(Number(row.trailingActivationPct ?? 0.8), 0.2, 10),
          trailingDeltaPct: clampPct(Number(row.trailingDeltaPct ?? 0.4), 0.1, 10),
        }
      : cexExitDefaults()
    cache.set(userId, { at: Date.now(), settings })
    return settings
  } catch (err) {
    // Never let a DB blip disable the stop-loss — fall back to the last known
    // value, or to the env defaults if we have never read one.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), userId },
      '[cex-exit] read failed — using cached/default exit settings',
    )
    return hit?.settings ?? cexExitDefaults()
  }
}

export async function setCexExitSettings(
  userId: string,
  raw: Partial<CexExitSettings>,
): Promise<CexExitSettings> {
  const prev = await getCexExitSettings(userId)
  const next: CexExitSettings = {
    enabled: raw.enabled ?? prev.enabled,
    takeProfitPct: clampPct(raw.takeProfitPct ?? prev.takeProfitPct, 0.2, 50),
    stopLossPct: clampPct(raw.stopLossPct ?? prev.stopLossPct, 0.2, 50),
    profitSkim: raw.profitSkim ?? prev.profitSkim,
    trailingStop: raw.trailingStop ?? prev.trailingStop,
    trailingActivationPct: clampPct(raw.trailingActivationPct ?? prev.trailingActivationPct, 0.2, 10),
    trailingDeltaPct: clampPct(raw.trailingDeltaPct ?? prev.trailingDeltaPct, 0.1, 10),
  }
  await prisma.cexExitConfig.upsert({
    where: { userId },
    create: { userId, ...next },
    update: next,
  })
  cache.set(userId, { at: Date.now(), settings: next })
  return next
}
