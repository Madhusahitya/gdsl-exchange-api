/**
 * Cached Jupiter tradable token registry — bulk discovery via Tokens API v2.
 */
import { SOL_DEX_CATALOG } from '../../lib/solDexCatalog'
import { logger } from '../../lib/logger'
import { isJupiterConfigured } from './jupiterClassicService'
import { discoverJupiterTradableTokens } from './jupiterTokenListService'
import { resolveSolTokenForBinanceSymbol, type ResolvedSolToken } from './solTokenResolver'

export type JupiterTradableToken = ResolvedSolToken

let cache: { at: number; tokens: JupiterTradableToken[]; symbols: string[] } | null = null
let refreshInFlight: Promise<void> | null = null
let discovering = false
const TTL_MS = 30 * 60 * 1000

async function refreshRegistry(): Promise<void> {
  discovering = true
  try {
    const tokens = await discoverJupiterTradableTokens()
    cache = {
      at: Date.now(),
      tokens,
      symbols: tokens.map((t) => t.binanceSymbol),
    }
    logger.info({ count: tokens.length }, '[jupiterRegistry] refreshed tradable token list')
  } finally {
    discovering = false
  }
}

function scheduleBackgroundRefresh(): void {
  if (refreshInFlight) return
  refreshInFlight = refreshRegistry()
    .catch((err) => logger.warn({ err }, '[jupiterRegistry] background refresh failed'))
    .finally(() => {
      refreshInFlight = null
    })
}

/** Warm cache on API startup (non-blocking). */
export function warmJupiterTradableRegistry(): void {
  if (!isJupiterConfigured()) return
  scheduleBackgroundRefresh()
}

export function isJupiterRegistryDiscovering(): boolean {
  return discovering
}

function seedFallback(): JupiterTradableToken[] {
  return SOL_DEX_CATALOG.map((t) => ({ ...t, source: 'catalog' as const }))
}

/** Cached tradable list; triggers refresh when stale or empty. */
export async function getJupiterTradableRegistry(): Promise<{
  tokens: JupiterTradableToken[]
  symbols: string[]
  cached: boolean
  discovering: boolean
  updatedAt: string
}> {
  const now = Date.now()
  const stale = !cache || now - cache.at >= TTL_MS
  const empty = !cache || cache.tokens.length <= SOL_DEX_CATALOG.length

  if (cache && !stale) {
    return {
      tokens: cache.tokens,
      symbols: cache.symbols,
      cached: true,
      discovering,
      updatedAt: new Date(cache.at).toISOString(),
    }
  }

  if (!cache) {
    cache = {
      at: now,
      tokens: seedFallback(),
      symbols: seedFallback().map((t) => t.binanceSymbol),
    }
    scheduleBackgroundRefresh()
    return {
      tokens: cache.tokens,
      symbols: cache.symbols,
      cached: false,
      discovering: true,
      updatedAt: new Date(now).toISOString(),
    }
  }

  if (stale || empty) scheduleBackgroundRefresh()

  return {
    tokens: cache.tokens,
    symbols: cache.symbols,
    cached: !stale,
    discovering,
    updatedAt: new Date(cache.at).toISOString(),
  }
}

export async function getJupiterTradableToken(binanceSymbol: string): Promise<JupiterTradableToken | null> {
  const sym = binanceSymbol.toUpperCase()
  const reg = await getJupiterTradableRegistry()
  const hit = reg.tokens.find((t) => t.binanceSymbol === sym)
  if (hit) return hit
  return resolveSolTokenForBinanceSymbol(sym, { requireLiveRoute: false })
}
