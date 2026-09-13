/**
 * CoinGecko-backed search and prices for the floating crypto calculator.
 */
const COINGECKO = 'https://api.coingecko.com/api/v3'

const searchCache = new Map<string, { ts: number; items: CalcCoinResult[] }>()
const priceCache = new Map<string, { ts: number; usd: number }>()
const SEARCH_TTL_MS = 60_000
const PRICE_TTL_MS = 30_000

export type CalcCoinResult = {
  id: string
  symbol: string
  name: string
  thumb: string | null
  usdPrice: number | null
}

export async function searchCalcCoins(query: string): Promise<CalcCoinResult[]> {
  const q = query.trim()
  if (q.length < 1) return []
  const cacheKey = q.toLowerCase()
  const hit = searchCache.get(cacheKey)
  if (hit && Date.now() - hit.ts < SEARCH_TTL_MS) return hit.items

  const res = await fetch(`${COINGECKO}/search?query=${encodeURIComponent(q)}`, {
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) throw new Error('Coin search temporarily unavailable')
  const data = (await res.json()) as {
    coins?: Array<{ id: string; symbol: string; name: string; thumb?: string }>
  }
  const coins = (data.coins ?? []).slice(0, 12)
  const ids = coins.map((c) => c.id)
  const prices = ids.length > 0 ? await fetchCalcPricesByIds(ids) : new Map<string, number>()

  const items: CalcCoinResult[] = coins.map((c) => ({
    id: c.id,
    symbol: c.symbol.toUpperCase(),
    name: c.name,
    thumb: c.thumb ?? null,
    usdPrice: prices.get(c.id) ?? null,
  }))
  searchCache.set(cacheKey, { ts: Date.now(), items })
  return items
}

export async function fetchCalcPricesByIds(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const missing: string[] = []
  for (const id of ids) {
    const hit = priceCache.get(id)
    if (hit && Date.now() - hit.ts < PRICE_TTL_MS) out.set(id, hit.usd)
    else missing.push(id)
  }
  if (missing.length === 0) return out

  const res = await fetch(
    `${COINGECKO}/simple/price?ids=${encodeURIComponent(missing.join(','))}&vs_currencies=usd`,
    { signal: AbortSignal.timeout(12_000) },
  )
  if (!res.ok) throw new Error('Price lookup temporarily unavailable')
  const data = (await res.json()) as Record<string, { usd?: number }>
  for (const id of missing) {
    const usd = data[id]?.usd
    if (typeof usd === 'number' && usd > 0) {
      priceCache.set(id, { ts: Date.now(), usd })
      out.set(id, usd)
    }
  }
  return out
}

export async function getCalcCoinPrice(id: string): Promise<number | null> {
  const prices = await fetchCalcPricesByIds([id])
  return prices.get(id) ?? null
}

/** Popular quick-picks for the calculator UI. */
export const CALC_QUICK_COINS: CalcCoinResult[] = [
  { id: 'tether', symbol: 'USDT', name: 'Tether', thumb: null, usdPrice: 1 },
  { id: 'usd-coin', symbol: 'USDC', name: 'USD Coin', thumb: null, usdPrice: 1 },
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', thumb: null, usdPrice: null },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum', thumb: null, usdPrice: null },
  { id: 'binancecoin', symbol: 'BNB', name: 'BNB', thumb: null, usdPrice: null },
  { id: 'solana', symbol: 'SOL', name: 'Solana', thumb: null, usdPrice: null },
]

export async function hydrateQuickCalcCoins(): Promise<CalcCoinResult[]> {
  const ids = CALC_QUICK_COINS.map((c) => c.id).filter((id) => id !== 'tether' && id !== 'usd-coin')
  const prices = await fetchCalcPricesByIds(ids).catch(() => new Map<string, number>())
  return CALC_QUICK_COINS.map((c) => ({
    ...c,
    usdPrice: c.usdPrice ?? prices.get(c.id) ?? null,
  }))
}
