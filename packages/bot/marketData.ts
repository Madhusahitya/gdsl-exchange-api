/**
 * Live Binance market data for realistic paper fills (bid / ask / mid).
 */
export type BookTicker = { bid: number; ask: number; mid: number }

const BINANCE_ENDPOINTS = [
  'https://data-api.binance.vision',
  'https://api3.binance.com',
  'https://api1.binance.com',
  'https://api.binance.com',
]

export async function fetchBookTicker(symbol: string): Promise<BookTicker | null> {
  const sym = encodeURIComponent(symbol)
  for (const base of BINANCE_ENDPOINTS) {
    try {
      const res = await fetch(`${base}/api/v3/ticker/bookTicker?symbol=${sym}`, {
        signal: AbortSignal.timeout(4000),
      })
      if (!res.ok) continue
      const data = (await res.json()) as { bidPrice?: string; askPrice?: string }
      const bid = parseFloat(data.bidPrice ?? '')
      const ask = parseFloat(data.askPrice ?? '')
      if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
        return { bid, ask, mid: (bid + ask) / 2 }
      }
    } catch {
      // try next endpoint
    }
  }
  return null
}
