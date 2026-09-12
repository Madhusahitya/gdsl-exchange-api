/**
 * Cached Binance spot symbol rules (LOT_SIZE / MARKET_LOT_SIZE / NOTIONAL).
 *
 * Shared by the OMS and the smart router so every order — manual, live bot, or
 * Auto Binance — is floored to stepSize and checked against minNotional before
 * it reaches Binance. Without this the exchange rejects with -1013 / -1111 and
 * the auto-trader only sees an opaque error.
 *
 * Reads the public `/exchangeInfo` endpoint, so no API keys are involved.
 */
import { parseSymbolRules, type ParsedSymbolRules } from '@cryptoflow/binance-executor'
import { logger } from '../../lib/logger'

const BINANCE_PUBLIC = (process.env.BINANCE_BASE_URL ?? 'https://api.binance.com').replace(/\/$/, '')
const TTL_MS = 60 * 60 * 1000

const cache = new Map<string, { rules: ParsedSymbolRules; at: number }>()
const inflight = new Map<string, Promise<ParsedSymbolRules>>()

async function fetchRules(symbol: string): Promise<ParsedSymbolRules> {
  const res = await fetch(
    `${BINANCE_PUBLIC}/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`,
    { signal: AbortSignal.timeout(8000) },
  )
  if (!res.ok) throw new Error(`Binance exchangeInfo failed (${res.status}) for ${symbol}`)
  const data = (await res.json()) as { symbols?: Array<Parameters<typeof parseSymbolRules>[0]> }
  const raw = data.symbols?.[0]
  if (!raw) throw new Error(`Symbol ${symbol} not found on Binance`)
  return parseSymbolRules(raw)
}

/** Throws when the symbol is unknown or exchangeInfo is unreachable. */
export async function getBinanceSymbolRules(symbol: string): Promise<ParsedSymbolRules> {
  const key = symbol.toUpperCase()
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rules

  const pending = inflight.get(key)
  if (pending) return pending

  const run = fetchRules(key)
    .then((rules) => {
      cache.set(key, { rules, at: Date.now() })
      return rules
    })
    .finally(() => {
      inflight.delete(key)
    })

  inflight.set(key, run)
  return run
}

/**
 * Same as `getBinanceSymbolRules` but returns null instead of throwing, and
 * serves a stale cache entry when the network call fails. Use on paths where a
 * transient exchangeInfo outage should not block an otherwise valid order.
 */
export async function tryGetBinanceSymbolRules(
  symbol: string,
): Promise<ParsedSymbolRules | null> {
  const key = symbol.toUpperCase()
  try {
    return await getBinanceSymbolRules(key)
  } catch (err) {
    const stale = cache.get(key)
    if (stale) return stale.rules
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), symbol: key },
      '[binance-rules] could not resolve symbol filters',
    )
    return null
  }
}
