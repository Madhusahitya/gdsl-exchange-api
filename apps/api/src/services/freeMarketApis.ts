/**
 * Aggregated free public APIs (no keys): Binance ping, CoinGecko, Alternative.me F&G, BSC gas estimate.
 */

export async function fetchBinanceServerTime(): Promise<number | null> {
  try {
    const r = await fetch('https://api.binance.com/api/v3/time')
    if (!r.ok) return null
    const j = (await r.json()) as { serverTime?: number }
    return typeof j.serverTime === 'number' ? j.serverTime : null
  } catch {
    return null
  }
}

export async function fetchCoinGeckoGlobal(): Promise<{
  activeCryptocurrencies: number | null
  markets: number | null
  totalMarketCapUsd: number | null
  btcDominancePct: number | null
} | null> {
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/global'
    )
    if (!r.ok) return null
    const j = (await r.json()) as {
      data?: {
        active_cryptocurrencies?: number
        markets?: number
        total_market_cap?: { usd?: number }
        market_cap_percentage?: { btc?: number }
      }
    }
    const d = j.data
    if (!d) return null
    return {
      activeCryptocurrencies: d.active_cryptocurrencies ?? null,
      markets: d.markets ?? null,
      totalMarketCapUsd: d.total_market_cap?.usd ?? null,
      btcDominancePct: d.market_cap_percentage?.btc ?? null,
    }
  } catch {
    return null
  }
}

export async function fetchFearGreed(): Promise<{ value: number; classification: string } | null> {
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=1')
    if (!r.ok) return null
    const j = (await r.json()) as {
      data?: Array<{ value?: string; value_classification?: string }>
    }
    const row = j.data?.[0]
    if (!row?.value) return null
    const value = parseInt(row.value, 10)
    if (!Number.isFinite(value)) return null
    return {
      value,
      classification: row.value_classification ?? 'unknown',
    }
  } catch {
    return null
  }
}

/** Public BSC RPC — eth_gasPrice (wei), rough network congestion signal */
/** BNB / USDT for rough on-chain fee USD estimates (monitoring only). */
export async function fetchBnbUsdtPrice(): Promise<number | null> {
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT')
    if (!r.ok) return null
    const j = (await r.json()) as { price?: string }
    const p = parseFloat(j.price ?? '')
    return Number.isFinite(p) && p > 0 ? p : null
  } catch {
    return null
  }
}

export async function fetchBscGasGwei(): Promise<number | null> {
  try {
    const r = await fetch('https://bsc-dataseed.binance.org/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_gasPrice',
        params: [],
      }),
    })
    if (!r.ok) return null
    const j = (await r.json()) as { result?: string }
    const hex = j.result
    if (!hex || !hex.startsWith('0x')) return null
    const wei = BigInt(hex)
    const gwei = Number(wei) / 1e9
    return Number.isFinite(gwei) ? gwei : null
  } catch {
    return null
  }
}

export async function fetchFreeMarketBundle() {
  const [binanceTime, coingecko, fearGreed, bscGasGwei] = await Promise.all([
    fetchBinanceServerTime(),
    fetchCoinGeckoGlobal(),
    fetchFearGreed(),
    fetchBscGasGwei(),
  ])

  return {
    fetchedAt: new Date().toISOString(),
    binanceServerTimeMs: binanceTime,
    coingecko,
    fearGreed,
    bsc: {
      gasPriceGwei: bscGasGwei,
      note: 'Public RPC eth_gasPrice; not a swap quote.',
    },
  }
}
