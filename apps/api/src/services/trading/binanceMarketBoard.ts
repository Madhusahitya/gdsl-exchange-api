/** Shared Binance USDT spot board (24h ticker, all pairs) — short server cache to limit weight. */

export type MarketBoardRow = {
  symbol: string
  lastPrice: number
  priceChangePercent: number
  highPrice: number
  lowPrice: number
  quoteVolume: number
  baseVolume: number
}

let cache: { at: number; rows: MarketBoardRow[] } | null = null
const TTL_MS = 12_000

function isSpotUsdtPair(symbol: string): boolean {
  if (!symbol.endsWith('USDT')) return false
  if (symbol.length < 6 || symbol.length > 32) return false
  if (!/^[A-Z0-9]+USDT$/.test(symbol)) return false
  if (/(UP|DOWN|BULL|BEAR)(USDT)$/.test(symbol)) return false
  if (symbol.startsWith('USDT')) return false
  return true
}

export async function getBinanceUsdtMarketBoard(limit: number): Promise<{ rows: MarketBoardRow[]; updatedAt: string; cached: boolean }> {
  const cap = Math.min(2000, Math.max(50, limit))
  const now = Date.now()
  if (cache && now - cache.at < TTL_MS) {
    return { rows: cache.rows.slice(0, cap), updatedAt: new Date(cache.at).toISOString(), cached: true }
  }

  const r = await fetch('https://api.binance.com/api/v3/ticker/24hr')
  if (!r.ok) {
    throw new Error(`Binance ticker error ${r.status}`)
  }
  const raw = (await r.json()) as Array<{
    symbol?: string
    lastPrice?: string
    priceChangePercent?: string
    highPrice?: string
    lowPrice?: string
    quoteVolume?: string
    volume?: string
  }>
  if (!Array.isArray(raw)) {
    throw new Error('Invalid Binance payload')
  }

  const rows: MarketBoardRow[] = []
  for (const t of raw) {
    const sym = t.symbol
    if (!sym || !isSpotUsdtPair(sym)) continue
    const lastPrice = parseFloat(t.lastPrice ?? 'NaN')
    const quoteVolume = parseFloat(t.quoteVolume ?? 'NaN')
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) continue
    if (!Number.isFinite(quoteVolume) || quoteVolume < 0) continue
    rows.push({
      symbol: sym,
      lastPrice,
      priceChangePercent: parseFloat(t.priceChangePercent ?? '0') || 0,
      highPrice: parseFloat(t.highPrice ?? '0') || 0,
      lowPrice: parseFloat(t.lowPrice ?? '0') || 0,
      quoteVolume,
      baseVolume: parseFloat(t.volume ?? '0') || 0,
    })
  }

  rows.sort((a, b) => b.quoteVolume - a.quoteVolume)
  cache = { at: now, rows }
  return { rows: rows.slice(0, cap), updatedAt: new Date(now).toISOString(), cached: false }
}
