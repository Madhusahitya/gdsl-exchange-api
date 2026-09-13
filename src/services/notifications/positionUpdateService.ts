/**
 * Open-position Telegram updates — keeps users connected to running trades
 * without spamming them.
 *
 * Two kinds of messages, both heavily throttled:
 *  1. Profit milestones — fired ONCE per threshold crossed (+0.5%, +1%, +1.5% …),
 *     always with the "you can skim this profit" nudge.
 *  2. Position digest — at most one per 6h per position, only when the PnL has
 *     moved meaningfully since the last digest.
 *
 * Hard caps:
 *  - First sighting of a position is SILENT (a redeploy never re-announces).
 *  - Max 1 position-update message per 10 minutes per user across all venues.
 *
 * State is in-memory: a restart simply re-initializes silently. Callers already
 * compute the live mark for exit logic, so tracking adds zero extra API load.
 */
import { logger } from '../../lib/logger'
import { telegramService } from './telegramService'

export type PositionTrackInput = {
  userId: string
  symbol: string
  pair: string
  entryPrice: number
  mark: number
  pnlPct: number
  pnlUsd: number | null
  takeProfitPct: number
  stopLossPct: number
  trailingStop: boolean
  skimmedUsd?: number
  openedAt: number
}

type TrackedState = {
  initialized: boolean
  lastMilestone: number
  lastDigestAt: number
  lastDigestPct: number
}

/** Profit thresholds (%) that each fire exactly once per position. */
const MILESTONES = [0.5, 1, 1.5, 2, 3, 4, 5, 7, 10, 15, 20]
const DIGEST_INTERVAL_MS = 6 * 60 * 60_000
const DIGEST_MIN_AGE_MS = 60 * 60_000
const DIGEST_MIN_MOVE_PCT = 0.3
const USER_MIN_INTERVAL_MS = 10 * 60_000
/** Drop tracking state for positions not seen for 7 days (closed elsewhere). */
const STALE_MS = 7 * 24 * 60 * 60_000
/** Lazy prune cadence — runs inside track(), no extra timer needed. */
const PRUNE_INTERVAL_MS = 60 * 60_000

const stateByKey = new Map<string, TrackedState & { seenAt: number }>()
const lastUserUpdateAt = new Map<string, number>()
let lastPruneAt = 0

function maybePrune(now: number): void {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return
  lastPruneAt = now
  prunePositionTracking()
}

function userRateLimited(userId: string): boolean {
  const last = lastUserUpdateAt.get(userId) ?? 0
  return Date.now() - last < USER_MIN_INTERVAL_MS
}

function track(venue: 'Jupiter' | 'Binance', key: string, input: PositionTrackInput): void {
  const now = Date.now()
  maybePrune(now)
  let st = stateByKey.get(key)

  if (!st) {
    // Silent initialization — never burst-notify on deploy/restart.
    st = {
      initialized: true,
      lastMilestone: MILESTONES.filter((m) => input.pnlPct >= m).pop() ?? 0,
      lastDigestAt: now,
      lastDigestPct: input.pnlPct,
      seenAt: now,
    }
    stateByKey.set(key, st)
    return
  }
  st.seenAt = now

  if (userRateLimited(input.userId)) return

  // 1) Profit milestone — once per threshold, with the skim nudge.
  const crossed = MILESTONES.filter((m) => input.pnlPct >= m && m > st!.lastMilestone).pop()
  if (crossed != null) {
    st.lastMilestone = crossed
    st.lastDigestAt = now
    st.lastDigestPct = input.pnlPct
    lastUserUpdateAt.set(input.userId, now)
    void telegramService
      .notifyPositionUpdate({ ...input, venue, milestonePct: crossed, digest: false })
      .catch((err) => logger.debug({ err, userId: input.userId }, '[position-updates] milestone notify failed'))
    return
  }

  // 2) Periodic digest — 6h cadence, only on meaningful movement.
  const ageMs = now - input.openedAt
  const dueDigest = now - st.lastDigestAt >= DIGEST_INTERVAL_MS
  const movedEnough = Math.abs(input.pnlPct - st.lastDigestPct) >= DIGEST_MIN_MOVE_PCT
  if (dueDigest && movedEnough && ageMs >= DIGEST_MIN_AGE_MS) {
    st.lastDigestAt = now
    st.lastDigestPct = input.pnlPct
    lastUserUpdateAt.set(input.userId, now)
    void telegramService
      .notifyPositionUpdate({ ...input, venue, milestonePct: null, digest: true })
      .catch((err) => logger.debug({ err, userId: input.userId }, '[position-updates] digest notify failed'))
  }
}

/** Called from the Jupiter open-position watcher (mark already computed there). */
export function trackJupiterOpenPosition(tradeId: string, input: PositionTrackInput): void {
  try {
    track('Jupiter', `jupiter:${tradeId}`, input)
  } catch (err) {
    logger.debug({ err }, '[position-updates] jupiter track failed')
  }
}

/** Called from the CEX Super Machine tick (single open lot per user). */
export function trackCexOpenPosition(input: PositionTrackInput): void {
  try {
    track('Binance', `cex:${input.userId}`, input)
  } catch (err) {
    logger.debug({ err }, '[position-updates] cex track failed')
  }
}

/** Drop CEX tracking when the lot closes so the next position starts fresh. */
export function clearCexPositionTracking(userId: string): void {
  stateByKey.delete(`cex:${userId}`)
}

/** Periodic prune of stale entries (positions closed while tracking was off). */
export function prunePositionTracking(): void {
  const cutoff = Date.now() - STALE_MS
  for (const [key, st] of stateByKey) {
    if (st.seenAt < cutoff) stateByKey.delete(key)
  }
}
