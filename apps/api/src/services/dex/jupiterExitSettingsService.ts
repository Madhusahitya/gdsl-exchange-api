/**
 * Per-user take-profit / stop-loss / trailing-stop prefs for DEX Jupiter.
 * Cached in memory, persisted to `JupiterExitConfig` so they survive restarts.
 */
import { prisma } from '@cryptoflow/db'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'

export type JupiterExitSettings = {
  enabled: boolean
  takeProfitPct: number
  stopLossPct: number
  trailingStop: boolean
  /** Bank profit at TP% but keep the position open until stop-loss. */
  profitSkim: boolean
  /** Trailing arms only once price is this % above entry (keeps it out of fee noise). */
  trailingActivationPct: number
  /** Once armed, exit when price falls this % below the peak. */
  trailingDeltaPct: number
}

const DEFAULTS: JupiterExitSettings = {
  enabled: true,
  /** Default 1.0% — must clear typical Jupiter round-trip (~0.3–0.7%) with room for skim. */
  takeProfitPct: 1.0,
  stopLossPct: env.dexAutoStopLossPct,
  trailingStop: false,
  profitSkim: true,
  trailingActivationPct: 0.8,
  trailingDeltaPct: 0.4,
}

const settingsByUser = new Map<string, JupiterExitSettings>()
/** Users whose DB row has been loaded (or confirmed absent) this process lifetime. */
const hydrated = new Set<string>()
/** Peak Jupiter sell mark since entry — key `${userId}:${baseSymbol}`. */
const trailingPeakByKey = new Map<string, number>()

function clampPct(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

function hydrateFromDb(userId: string): void {
  if (hydrated.has(userId)) return
  hydrated.add(userId)
  void prisma.jupiterExitConfig
    .findUnique({ where: { userId } })
    .then((row) => {
      if (!row) return
      settingsByUser.set(userId, {
        enabled: row.enabled,
        takeProfitPct: clampPct(Number(row.takeProfitPct), 0.1, 50),
        stopLossPct: clampPct(Number(row.stopLossPct), 0.1, 50),
        trailingStop: row.trailingStop,
        profitSkim: row.profitSkim,
        trailingActivationPct: clampPct(Number(row.trailingActivationPct ?? DEFAULTS.trailingActivationPct), 0.2, 10),
        trailingDeltaPct: clampPct(Number(row.trailingDeltaPct ?? DEFAULTS.trailingDeltaPct), 0.1, 10),
      })
    })
    .catch((err) => {
      hydrated.delete(userId)
      logger.warn({ err, userId }, '[jupiterExit] settings hydrate failed')
    })
}

export function getJupiterExitSettings(userId: string): JupiterExitSettings {
  hydrateFromDb(userId)
  return settingsByUser.get(userId) ?? { ...DEFAULTS }
}

export function setJupiterExitSettings(userId: string, raw: Partial<JupiterExitSettings>): JupiterExitSettings {
  const prev = getJupiterExitSettings(userId)
  const next: JupiterExitSettings = {
    enabled: raw.enabled ?? prev.enabled,
    takeProfitPct: clampPct(raw.takeProfitPct ?? prev.takeProfitPct, 0.1, 50),
    stopLossPct: clampPct(raw.stopLossPct ?? prev.stopLossPct, 0.1, 50),
    trailingStop: raw.trailingStop ?? prev.trailingStop,
    profitSkim: raw.profitSkim ?? prev.profitSkim,
    trailingActivationPct: clampPct(raw.trailingActivationPct ?? prev.trailingActivationPct, 0.2, 10),
    trailingDeltaPct: clampPct(raw.trailingDeltaPct ?? prev.trailingDeltaPct, 0.1, 10),
  }
  settingsByUser.set(userId, next)
  hydrated.add(userId)
  void prisma.jupiterExitConfig
    .upsert({
      where: { userId },
      create: { userId, ...next },
      update: next,
    })
    .catch((err) => logger.warn({ err, userId }, '[jupiterExit] settings persist failed'))
  return next
}

export function trailingPeakKey(userId: string, baseSymbol: string): string {
  return `${userId}:${baseSymbol.toUpperCase()}`
}

export function getTrailingPeak(userId: string, baseSymbol: string): number | undefined {
  return trailingPeakByKey.get(trailingPeakKey(userId, baseSymbol))
}

export function updateTrailingPeak(userId: string, baseSymbol: string, mark: number): number {
  const key = trailingPeakKey(userId, baseSymbol)
  const prev = trailingPeakByKey.get(key) ?? 0
  const next = Math.max(prev, mark)
  trailingPeakByKey.set(key, next)
  return next
}

export function clearTrailingPeak(userId: string, baseSymbol: string): void {
  trailingPeakByKey.delete(trailingPeakKey(userId, baseSymbol))
}
