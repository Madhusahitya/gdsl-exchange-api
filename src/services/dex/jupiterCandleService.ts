/**
 * Jupiter-aligned candlesticks:
 *  - Binance-listed tokens: Binance OHLC shape scaled to Jupiter live spot.
 *  - Solana-native tokens (no Binance pair): GeckoTerminal on-chain OHLCV.
 * Last bar is overwritten with Jupiter Price API v3 every refresh.
 */
import { logger } from '../../lib/logger'
import { fetchJupiterPricesV3 } from './jupiterPriceService'
import { getJupiterTradableToken } from './jupiterTradableRegistry'

export type JupiterCandle = {
  openTime: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  closeTime: number
}

const SUPPORTED_INTERVALS = new Set(['1m', '5m', '15m', '1h', '4h', '1d'])

const GECKO_TF: Record<string, { tf: 'minute' | 'hour' | 'day'; aggregate: number }> = {
  '1m': { tf: 'minute', aggregate: 1 },
  '5m': { tf: 'minute', aggregate: 5 },
  '15m': { tf: 'minute', aggregate: 15 },
  '1h': { tf: 'hour', aggregate: 1 },
  '4h': { tf: 'hour', aggregate: 4 },
  '1d': { tf: 'day', aggregate: 1 },
}

const poolCache = new Map<string, { at: number; pool: string | null }>()
const POOL_TTL_MS = 10 * 60_000
const ohlcvCache = new Map<string, { at: number; candles: JupiterCandle[] }>()
const OHLCV_TTL_MS = 20_000

/**
 * Last successfully served candle series per `sym|interval`. When upstream
 * sources (Binance/GeckoTerminal) fail or rate-limit, we serve this instead of
 * erroring so the chart never goes blank mid-session.
 */
const lastGoodCache = new Map<string, { at: number; candles: JupiterCandle[] }>()
const LAST_GOOD_TTL_MS = 30 * 60_000

/** Dedupe concurrent fetches for the same key (protects GeckoTerminal rate limits). */
const inflight = new Map<string, Promise<JupiterCandle[]>>()

/** Top liquidity pool address for a mint on Solana (cached). */
async function getGeckoTopPool(mint: string): Promise<string | null> {
  const hit = poolCache.get(mint)
  if (hit && Date.now() - hit.at < POOL_TTL_MS) return hit.pool
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      poolCache.set(mint, { at: Date.now(), pool: null })
      return null
    }
    const body = (await res.json()) as { data?: Array<{ attributes?: { address?: string } }> }
    const pool = body.data?.[0]?.attributes?.address ?? null
    poolCache.set(mint, { at: Date.now(), pool })
    return pool
  } catch (err) {
    logger.warn({ err, mint }, '[jupiterCandles] gecko pool lookup failed')
    return null
  }
}

/** On-chain OHLCV from GeckoTerminal for a Solana-native token (cached, ascending order). */
async function fetchGeckoCandles(mint: string, interval: string, limit: number): Promise<JupiterCandle[]> {
  const cacheKey = `${mint}|${interval}|${limit}`
  const cached = ohlcvCache.get(cacheKey)
  if (cached && Date.now() - cached.at < OHLCV_TTL_MS) return cached.candles

  const pool = await getGeckoTopPool(mint)
  if (!pool) throw new Error('No Solana liquidity pool found for this token')
  const map = GECKO_TF[interval] ?? GECKO_TF['15m']
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/${map.tf}?aggregate=${map.aggregate}&limit=${Math.min(1000, limit)}&currency=usd`
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) })
  if (!res.ok) throw new Error(`GeckoTerminal OHLCV error ${res.status}`)
  const body = (await res.json()) as { data?: { attributes?: { ohlcv_list?: Array<Array<number | string>> } } }
  const list = body.data?.attributes?.ohlcv_list
  if (!Array.isArray(list) || list.length === 0) throw new Error('No on-chain candle data')

  const intervalMs = map.tf === 'day' ? 86_400_000 : map.tf === 'hour' ? 3_600_000 * map.aggregate : 60_000 * map.aggregate
  const candles: JupiterCandle[] = list
    .map((row) => {
      const openTime = Number(row[0]) * 1000
      return {
        openTime,
        open: parseFloat(String(row[1])),
        high: parseFloat(String(row[2])),
        low: parseFloat(String(row[3])),
        close: parseFloat(String(row[4])),
        volume: parseFloat(String(row[5])),
        closeTime: openTime + intervalMs - 1,
      }
    })
    .sort((a, b) => a.openTime - b.openTime)

  ohlcvCache.set(cacheKey, { at: Date.now(), candles })
  return candles
}

const BINANCE_ENDPOINTS = [
  'https://data-api.binance.vision',
  'https://api3.binance.com',
  'https://api1.binance.com',
  'https://api.binance.com',
]

async function fetchBinanceCandles(sym: string, interval: string, cap: number): Promise<JupiterCandle[]> {
  for (const base of BINANCE_ENDPOINTS) {
    try {
      const url = `${base}/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${cap}`
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) })
      if (!r.ok) continue
      const raw = (await r.json()) as Array<Array<string | number>>
      if (!Array.isArray(raw) || raw.length === 0) continue
      return raw.map((row) => ({
        openTime: Number(row[0]),
        open: parseFloat(String(row[1])),
        high: parseFloat(String(row[2])),
        low: parseFloat(String(row[3])),
        close: parseFloat(String(row[4])),
        volume: parseFloat(String(row[5])),
        closeTime: Number(row[6]),
      }))
    } catch {
      // try next endpoint
    }
  }
  throw new Error('Binance klines unavailable across all endpoints')
}

export async function getJupiterAlignedCandles(
  binanceSymbol: string,
  interval: string,
  limit: number,
): Promise<{
  symbol: string
  interval: string
  count: number
  updatedAt: string
  priceSource: 'jupiter_v3_live' | 'binance_unscaled' | 'gecko_onchain'
  mint: string | null
  jupiterPrice: number | null
  jupiterBlockId: number | null
  candles: JupiterCandle[]
  /** True when upstream candle history failed and we served the last good series. */
  stale?: boolean
  /** True when no candle history exists at all — only the live price is available. */
  degraded?: boolean
  note?: string
}> {
  const sym = binanceSymbol.toUpperCase()
  if (!SUPPORTED_INTERVALS.has(interval)) {
    throw new Error('Unsupported interval')
  }
  const cap = Math.min(500, Math.max(20, limit))

  const token = await getJupiterTradableToken(sym)
  if (!token) {
    throw new Error('Token not tradable on Solana via Jupiter')
  }

  const goodKey = `${sym}|${interval}`

  // Native tokens have no Binance pair → use on-chain OHLCV; others use Binance shape, falling back to on-chain.
  const fetchFresh = async (): Promise<JupiterCandle[]> => {
    if (token.native) {
      return fetchGeckoCandles(token.mint, interval, cap)
    }
    try {
      return await fetchBinanceCandles(sym, interval, cap)
    } catch {
      return fetchGeckoCandles(token.mint, interval, cap)
    }
  }

  let candles: JupiterCandle[] = []
  let stale = false
  let degraded = false
  let note: string | undefined
  try {
    let promise = inflight.get(goodKey)
    if (!promise) {
      promise = fetchFresh()
      inflight.set(goodKey, promise)
      promise.finally(() => inflight.delete(goodKey)).catch(() => null)
    }
    candles = await promise
    lastGoodCache.set(goodKey, { at: Date.now(), candles })
  } catch (err) {
    const lastGood = lastGoodCache.get(goodKey)
    if (lastGood && Date.now() - lastGood.at < LAST_GOOD_TTL_MS) {
      candles = lastGood.candles
      stale = true
      note = 'Chart history source is briefly rate-limited — showing last snapshot, live price still updating.'
      logger.debug({ sym, interval }, '[jupiterCandles] serving stale last-good candles')
    } else {
      // No history anywhere — degrade gracefully to live-price-only instead of a 502.
      degraded = true
      note = 'No candle history available for this token yet — live Jupiter price shown below.'
      logger.warn({ err, sym, interval }, '[jupiterCandles] all candle sources failed — degraded response')
    }
  }

  const prices = await fetchJupiterPricesV3([token.mint])
  const live = prices.get(token.mint)
  const binanceLast = candles[candles.length - 1]?.close ?? 0
  let priceSource: 'jupiter_v3_live' | 'binance_unscaled' | 'gecko_onchain' = token.native
    ? 'gecko_onchain'
    : 'binance_unscaled'

  if (live && binanceLast > 0) {
    const scale = live.usdPrice / binanceLast
    // Only scale when Binance and Jupiter disagree meaningfully — otherwise leave as-is.
    if (Math.abs(scale - 1) > 0.0005) {
      for (const c of candles) {
        c.open *= scale
        c.high *= scale
        c.low *= scale
        c.close *= scale
      }
    }
    const last = candles[candles.length - 1]
    if (last) {
      last.close = live.usdPrice
      last.high = Math.max(last.high, live.usdPrice)
      last.low = Math.min(last.low, live.usdPrice)
    }
    priceSource = 'jupiter_v3_live'
  } else if (!live && binanceLast > 0 && !token.native) {
    note =
      (note ? `${note} ` : '') +
      'Live Jupiter price unavailable — chart may show CEX shape until Price API recovers. Live bid uses Jupiter sell quote.'
  } else if (live && candles.length === 0) {
    // Degraded: synthesize a flat last bar so the chart header matches Jupiter mid.
    candles = [
      {
        openTime: Date.now() - 60_000,
        open: live.usdPrice,
        high: live.usdPrice,
        low: live.usdPrice,
        close: live.usdPrice,
        volume: 0,
        closeTime: Date.now(),
      },
    ]
    degraded = true
    priceSource = 'jupiter_v3_live'
    note = note ?? 'No candle history — showing live Jupiter mid only.'
  }

  return {
    symbol: sym,
    interval,
    count: candles.length,
    updatedAt: new Date().toISOString(),
    priceSource,
    mint: token.mint,
    jupiterPrice: live?.usdPrice ?? null,
    jupiterBlockId: live?.blockId ?? null,
    candles,
    stale: stale || undefined,
    degraded: degraded || undefined,
    note,
  }
}

/** Lightweight live price — same Jupiter bid/ask/mid marks as chart, book, and positions. */
export async function getJupiterLivePrice(binanceSymbol: string): Promise<{
  symbol: string
  mint: string | null
  price: number | null
  bid: number | null
  ask: number | null
  mid: number | null
  spreadBps: number | null
  blockId: number | null
  updatedAt: string
}> {
  const sym = binanceSymbol.toUpperCase()
  const token = await getJupiterTradableToken(sym)
  if (!token) throw new Error('Token not tradable on Solana via Jupiter')

  const { getJupiterExecutableMarks } = await import('./jupiterMarkService')
  const marks = await getJupiterExecutableMarks(sym)
  const prices = await fetchJupiterPricesV3([token.mint])
  const live = prices.get(token.mint)

  const mid = marks?.mid ?? live?.usdPrice ?? null
  return {
    symbol: sym,
    mint: token.mint,
    price: mid,
    bid: marks?.bid ?? null,
    ask: marks?.ask ?? null,
    mid,
    spreadBps: marks?.spreadBps ?? null,
    blockId: live?.blockId ?? null,
    updatedAt: new Date().toISOString(),
  }
}
