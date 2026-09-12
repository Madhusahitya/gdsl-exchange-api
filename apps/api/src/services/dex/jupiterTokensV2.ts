/**
 * Jupiter Tokens API v2 client — rich token rows (price, liquidity, momentum stats).
 * Single source for both bulk discovery (/tag) and the momentum scanner (/toptrending).
 * https://dev.jup.ag/docs/tokens/v2/token-information
 */
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'

export type JupiterSwapStats = {
  priceChange?: number
  volumeChange?: number
  buyVolume?: number
  sellVolume?: number
  numBuys?: number
  numSells?: number
  numTraders?: number
}

export type JupiterV2Token = {
  id?: string
  symbol?: string
  name?: string
  decimals?: number
  icon?: string
  isVerified?: boolean
  tags?: string[]
  usdPrice?: number
  liquidity?: number
  mcap?: number
  holderCount?: number
  organicScore?: number
  organicScoreLabel?: 'high' | 'medium' | 'low'
  audit?: {
    isSus?: boolean
    mintAuthorityDisabled?: boolean
    freezeAuthorityDisabled?: boolean
    topHoldersPercentage?: number
  } | null
  stats5m?: JupiterSwapStats | null
  stats1h?: JupiterSwapStats | null
  stats6h?: JupiterSwapStats | null
  stats24h?: JupiterSwapStats | null
}

function apiKey(): string | null {
  return env.JUPITER_API_KEY?.trim() || null
}

async function fetchV2(path: string, timeoutMs: number): Promise<JupiterV2Token[]> {
  const key = apiKey()
  if (!key) return []
  try {
    const res = await fetch(`https://api.jup.ag/tokens/v2/${path}`, {
      headers: { 'x-api-key': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      logger.warn({ path, status: res.status }, '[jupiterTokensV2] fetch failed')
      return []
    }
    const body = await res.json()
    return Array.isArray(body) ? (body as JupiterV2Token[]) : []
  } catch (err) {
    logger.warn({ err, path }, '[jupiterTokensV2] fetch error')
    return []
  }
}

/** Bulk tag listing — `verified`, `lst`, `stocks`. */
export function fetchJupiterTag(tag: 'verified' | 'lst' | 'stocks'): Promise<JupiterV2Token[]> {
  return fetchV2(`tag?query=${tag}`, 45_000)
}

/** Ranked trending tokens for a window — `5m`, `1h`, `6h`, `24h`. */
export function fetchJupiterTopTrending(interval: '5m' | '1h' | '6h' | '24h'): Promise<JupiterV2Token[]> {
  return fetchV2(`toptrending/${interval}`, 15_000)
}

/** Conservative safety gate so the long tail can't route into obvious junk/rugs. */
export function isJupiterTokenSafe(t: JupiterV2Token, minLiquidityUsd = 10_000): boolean {
  if (!t.id || t.decimals == null || !t.symbol) return false
  if (t.audit?.isSus) return false
  if (!t.usdPrice || !Number.isFinite(t.usdPrice) || t.usdPrice <= 0) return false
  if ((t.liquidity ?? 0) < minLiquidityUsd) return false
  // Verified OR a healthy organic-activity score keeps scam tokens out.
  if (!t.isVerified && (t.organicScore ?? 0) < 50) return false
  return true
}
