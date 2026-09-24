/**
 * Jupiter Price API v3 — live USD prices on Solana (same source as jup.ag).
 * https://dev.jup.ag/docs/price
 */
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'

export type JupiterPriceQuote = {
  mint: string
  usdPrice: number
  priceChange24h: number | null
  blockId: number | null
  decimals: number | null
}

type PriceV3Payload = Record<
  string,
  {
    usdPrice?: number
    priceChange24h?: number
    blockId?: number
    decimals?: number
  }
>

export function isJupiterPriceConfigured(): boolean {
  return Boolean(env.JUPITER_API_KEY?.trim())
}

/** Per-mint price cache. `ts` = last successful fetch. Stale entries are kept for 429 fallback. */
const priceCache = new Map<string, { quote: JupiterPriceQuote; ts: number }>()
/** Prices younger than this are served from cache without hitting Jupiter. */
const PRICE_FRESH_MS = 1_000
/** Stale prices up to this age are still served when Jupiter is rate-limiting. */
const PRICE_STALE_MS = 5 * 60_000
let rateLimitedUntil = 0

export function isJupiterPriceRateLimited(): boolean {
  return Date.now() < rateLimitedUntil
}

function ingestPricePayload(mints: string[], body: PriceV3Payload): number {
  const now = Date.now()
  let n = 0
  for (const mint of mints) {
    const row = body[mint]
    if (!row?.usdPrice || !Number.isFinite(row.usdPrice) || row.usdPrice <= 0) continue
    priceCache.set(mint, {
      ts: now,
      quote: {
        mint,
        usdPrice: row.usdPrice,
        priceChange24h:
          row.priceChange24h != null && Number.isFinite(row.priceChange24h) ? row.priceChange24h : null,
        blockId: row.blockId != null && Number.isFinite(row.blockId) ? row.blockId : null,
        decimals: row.decimals != null && Number.isFinite(row.decimals) ? row.decimals : null,
      },
    })
    n += 1
  }
  return n
}

async function fetchPricesFromJupiter(mints: string[]): Promise<void> {
  if (mints.length === 0) return
  const key = env.JUPITER_API_KEY?.trim()
  const ids = encodeURIComponent(mints.join(','))

  // Prefer authenticated portal API; fall back to lite (no key) so wallet
  // portfolio totals still match Solscan when the key is missing/rate-limited.
  const endpoints: Array<{ url: string; headers: Record<string, string>; label: string }> = []
  if (key) {
    endpoints.push({
      url: `https://api.jup.ag/price/v3?ids=${ids}`,
      headers: { 'x-api-key': key, Accept: 'application/json' },
      label: 'portal',
    })
  }
  endpoints.push({
    url: `https://lite-api.jup.ag/price/v3?ids=${ids}`,
    headers: { Accept: 'application/json' },
    label: 'lite',
  })

  for (const ep of endpoints) {
    try {
      const res = await fetch(ep.url, {
        headers: ep.headers,
        signal: AbortSignal.timeout(3_000),
      })
      if (res.status === 429) {
        rateLimitedUntil = Date.now() + 5_000
        logger.warn(`[jupiterPrice] ${ep.label} rate limited (429)`)
        continue
      }
      if (!res.ok) {
        logger.warn({ status: res.status, label: ep.label }, '[jupiterPrice] v3 HTTP error')
        continue
      }
      const body = (await res.json()) as PriceV3Payload
      const n = ingestPricePayload(mints, body)
      if (n > 0) return
    } catch (err) {
      logger.warn({ err, label: ep.label }, '[jupiterPrice] v3 fetch failed')
    }
  }
}

export async function fetchJupiterPricesV3(mints: string[]): Promise<Map<string, JupiterPriceQuote>> {
  const out = new Map<string, JupiterPriceQuote>()
  if (mints.length === 0) return out

  const unique = [...new Set(mints.filter(Boolean))].slice(0, 50)
  const now = Date.now()

  // Only fetch mints whose cached price is stale (and not currently rate-limited).
  const stale = unique.filter((m) => {
    const c = priceCache.get(m)
    return !c || now - c.ts >= PRICE_FRESH_MS
  })
  if (stale.length > 0) {
    try {
      await fetchPricesFromJupiter(stale)
    } catch (err) {
      logger.warn({ err }, '[jupiterPrice] v3 fetch failed — using cache')
    }
  }

  for (const mint of unique) {
    const c = priceCache.get(mint)
    if (c && Date.now() - c.ts <= PRICE_STALE_MS) out.set(mint, c.quote)
  }
  return out
}

/** Batch-fetch prices for more than 50 mints (cache-aware). */
export async function fetchJupiterPricesV3Batched(mints: string[]): Promise<Map<string, JupiterPriceQuote>> {
  const merged = new Map<string, JupiterPriceQuote>()
  const unique = [...new Set(mints.filter(Boolean))]
  const now = Date.now()

  // Collect stale mints first, then fetch in 50-mint chunks — fresh cached ones skip the network.
  const stale = unique.filter((m) => {
    const c = priceCache.get(m)
    return !c || now - c.ts >= PRICE_FRESH_MS
  })
  if (stale.length > 0) {
    for (let i = 0; i < stale.length; i += 50) {
      try {
        await fetchPricesFromJupiter(stale.slice(i, i + 50))
      } catch (err) {
        logger.warn({ err }, '[jupiterPrice] batched fetch failed — using cache')
        break
      }
    }
  }

  for (const mint of unique) {
    const c = priceCache.get(mint)
    if (c && Date.now() - c.ts <= PRICE_STALE_MS) merged.set(mint, c.quote)
  }
  return merged
}
