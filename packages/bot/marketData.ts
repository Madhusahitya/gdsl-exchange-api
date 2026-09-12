/**
 * Live Binance market data for realistic paper fills (bid / ask / mid).
 */
export type BookTicker = { bid: number; ask: number; mid: number }

export async function fetchBookTicker(symbol: string): Promise<BookTicker | null> {
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`
    )
    if (!res.ok) return null
    const data = (await res.json()) as { bidPrice?: string; askPrice?: string }
    const bid = parseFloat(data.bidPrice ?? '')
    const ask = parseFloat(data.askPrice ?? '')
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null
    return { bid, ask, mid: (bid + ask) / 2 }
  } catch {
    return null
  }
}
