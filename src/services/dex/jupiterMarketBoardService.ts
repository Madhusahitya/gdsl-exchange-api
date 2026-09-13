/**
 * Jupiter live market board — prices from Price API v3 on Solana, sorted by Binance volume.
 */
import { getBinanceUsdtMarketBoard, type MarketBoardRow } from '../trading/binanceMarketBoard'
import { fetchJupiterPricesV3Batched } from './jupiterPriceService'
import { getJupiterTradableRegistry, isJupiterRegistryDiscovering } from './jupiterTradableRegistry'

export type JupiterMarketBoardRow = MarketBoardRow & {
  priceSource: 'jupiter_v3'
  mint: string
  baseSymbol: string
  jupiterBlockId: number | null
  tradableOnSolana: true
}

let boardCache: { at: number; rows: JupiterMarketBoardRow[]; tradableCount: number; discovering: boolean } | null = null
const BOARD_TTL_MS = 20_000

export async function getJupiterLiveMarketBoard(limit: number): Promise<{
  rows: JupiterMarketBoardRow[]
  updatedAt: string
  cached: boolean
  tradableCount: number
  discovering: boolean
}> {
  const cap = Math.min(2000, Math.max(20, limit))
  const now = Date.now()
  if (boardCache && now - boardCache.at < BOARD_TTL_MS) {
    return {
      rows: boardCache.rows.slice(0, cap),
      updatedAt: new Date(boardCache.at).toISOString(),
      cached: true,
      tradableCount: boardCache.tradableCount,
      discovering: boardCache.discovering,
    }
  }
  const registry = await getJupiterTradableRegistry()

  // Snapshot rows straight from the enriched registry (price/liquidity/volume from Jupiter v2).
  const ranked = [...registry.tokens].sort(
    (a, b) => (b.volume24hUsd ?? b.liquidityUsd ?? 0) - (a.volume24hUsd ?? a.liquidityUsd ?? 0),
  )

  // Only the most-liquid head gets a fresh Price v3 overlay — keeps API calls bounded for thousands.
  const LIVE_OVERLAY_COUNT = 120
  const headMints = ranked.slice(0, LIVE_OVERLAY_COUNT).map((t) => t.mint)
  const [board, livePrices] = await Promise.all([
    getBinanceUsdtMarketBoard(2000).catch(() => ({ rows: [] as MarketBoardRow[] })),
    fetchJupiterPricesV3Batched(headMints).catch(() => new Map()),
  ])
  const binanceBySymbol = new Map(board.rows.map((r) => [r.symbol, r] as const))

  const rows: JupiterMarketBoardRow[] = []
  for (const token of ranked) {
    const live = livePrices.get(token.mint)
    const price = live?.usdPrice ?? token.usdPrice ?? 0
    if (price <= 0) continue
    const binanceRow = token.hasBinance ? binanceBySymbol.get(token.binanceSymbol) : undefined
    const pct = live?.priceChange24h ?? token.priceChange24h ?? binanceRow?.priceChangePercent ?? 0
    const quoteVolume = token.volume24hUsd ?? binanceRow?.quoteVolume ?? token.liquidityUsd ?? 0
    const refHigh = binanceRow?.highPrice ?? price
    const refLow = binanceRow?.lowPrice ?? price
    const ratio = binanceRow && binanceRow.lastPrice > 0 ? price / binanceRow.lastPrice : 1
    rows.push({
      symbol: token.binanceSymbol,
      lastPrice: price,
      priceChangePercent: pct,
      highPrice: refHigh * ratio,
      lowPrice: refLow * ratio,
      quoteVolume,
      baseVolume: binanceRow?.baseVolume ?? 0,
      priceSource: 'jupiter_v3',
      mint: token.mint,
      baseSymbol: token.baseSymbol,
      jupiterBlockId: live?.blockId ?? null,
      tradableOnSolana: true,
    })
  }

  rows.sort((a, b) => b.quoteVolume - a.quoteVolume)
  const discovering = registry.discovering || isJupiterRegistryDiscovering()
  boardCache = { at: Date.now(), rows, tradableCount: registry.symbols.length, discovering }
  return {
    rows: rows.slice(0, cap),
    updatedAt: new Date().toISOString(),
    cached: registry.cached,
    tradableCount: registry.symbols.length,
    discovering,
  }
}
