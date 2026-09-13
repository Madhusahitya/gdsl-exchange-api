/**
 * Order book imbalance (OBI) service.
 * Polls Binance depth endpoint every 5s and caches latest OBI per symbol.
 *
 * OBI = (Σbid_vol_top10 - Σask_vol_top10) / (Σbid_vol_top10 + Σask_vol_top10)
 * OBI ∈ [-1, 1]. Positive = buy pressure, negative = sell pressure.
 */
import { logger } from '../../lib/logger'
import { SYMBOLS } from './klineService'

const BINANCE_REST = 'https://api.binance.com'
const DEPTH_LEVELS = 20

interface DepthResponse {
  bids: [string, string][]
  asks: [string, string][]
}

const obiCache = new Map<string, number>()

function computeOBI(bids: [string, string][], asks: [string, string][]): number {
  const bidVol = bids.slice(0, DEPTH_LEVELS).reduce((s, [, q]) => s + Number(q), 0)
  const askVol = asks.slice(0, DEPTH_LEVELS).reduce((s, [, q]) => s + Number(q), 0)
  const total = bidVol + askVol
  return total === 0 ? 0 : (bidVol - askVol) / total
}

async function fetchAndCache(symbol: string) {
  try {
    const res = await fetch(
      `${BINANCE_REST}/api/v3/depth?symbol=${symbol}&limit=${DEPTH_LEVELS}`,
      { signal: AbortSignal.timeout(5_000) }
    )
    if (!res.ok) return
    const data = await res.json() as DepthResponse
    const obi = computeOBI(data.bids, data.asks)
    obiCache.set(symbol, obi)
  } catch {
    // transient — keep last value
  }
}

let pollingTimer: ReturnType<typeof setInterval> | null = null

export const orderBookService = {
  start() {
    // Immediate fetch, then every 5s
    Promise.all(SYMBOLS.map(fetchAndCache)).catch(() => {})

    pollingTimer = setInterval(() => {
      Promise.all(SYMBOLS.map(fetchAndCache)).catch(() => {})
    }, 5_000)

    logger.info('[orderBook] Order book polling started')
  },

  stop() {
    if (pollingTimer) clearInterval(pollingTimer)
  },

  /** Returns OBI ∈ [-1, 1] or null if not yet fetched */
  getOBI(symbol: string): number | null {
    return obiCache.has(symbol) ? obiCache.get(symbol)! : null
  },

  /**
   * Live depth snapshot for CEX terminal UI (bids/asks + mid + OBI).
   * Additive — does not change the background OBI poller.
   */
  async getDepth(
    symbol: string,
    limit = 20,
  ): Promise<{
    symbol: string
    bids: Array<{ price: number; qty: number }>
    asks: Array<{ price: number; qty: number }>
    mid: number | null
    spreadBps: number | null
    obi: number | null
    updatedAt: string
  }> {
    const sym = symbol.replace('/', '').toUpperCase()
    const cap = Math.min(50, Math.max(5, limit))
    const res = await fetch(`${BINANCE_REST}/api/v3/depth?symbol=${sym}&limit=${cap}`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) throw new Error(`Binance depth ${res.status}`)
    const data = (await res.json()) as DepthResponse
    const bids = (data.bids ?? [])
      .map(([p, q]) => ({ price: Number(p), qty: Number(q) }))
      .filter((r) => Number.isFinite(r.price) && Number.isFinite(r.qty))
    const asks = (data.asks ?? [])
      .map(([p, q]) => ({ price: Number(p), qty: Number(q) }))
      .filter((r) => Number.isFinite(r.price) && Number.isFinite(r.qty))
    const bestBid = bids[0]?.price ?? null
    const bestAsk = asks[0]?.price ?? null
    const mid =
      bestBid != null && bestAsk != null && bestBid > 0 && bestAsk > 0
        ? (bestBid + bestAsk) / 2
        : (bestBid ?? bestAsk)
    const spreadBps =
      mid != null && bestBid != null && bestAsk != null ? ((bestAsk - bestBid) / mid) * 10_000 : null
    const obi = computeOBI(
      (data.bids ?? []) as [string, string][],
      (data.asks ?? []) as [string, string][],
    )
    obiCache.set(sym, obi)
    return {
      symbol: sym,
      bids,
      asks,
      mid,
      spreadBps,
      obi,
      updatedAt: new Date().toISOString(),
    }
  },
}
