/**
 * Real-time price ticker service for Solana / Jupiter markets.
 *
 * Runs a 2-second ticker loop that fetches live on-chain prices from Jupiter Price API v3
 * and broadcasts lightweight price diffs to all connected WebSocket clients.
 *
 * Only executes when at least one client is connected, conserving resources and external rate limits.
 */
import { pubsub } from '../../lib/pubsub'
import { getSocketIo } from '../../lib/realtimeHub'
import { logger } from '../../lib/logger'
import { SOL_DEX_CATALOG } from '../../lib/solDexCatalog'
import { fetchJupiterPricesV3 } from './jupiterPriceService'
import { getJupiterLiveMarketBoard } from './jupiterMarketBoardService'
import { getJupiterTradableRegistry } from './jupiterTradableRegistry'

export type JupiterPriceTick = {
  symbol: string
  mint: string
  lastPrice: number
  priceChangePercent: number
}

let tickerInterval: NodeJS.Timeout | null = null
let fullBoardCycleCounter = 0
const previousPrices = new Map<string, number>()

export function startJupiterLiveTicker(): void {
  if (tickerInterval) return

  logger.info('[jupiterTicker] starting real-time 2s price ticker stream')

  tickerInterval = setInterval(async () => {
    try {
      const io = getSocketIo()
      // Only stream when clients are connected via WebSocket / polling
      if (!io || io.engine.clientsCount === 0) return

      fullBoardCycleCounter++

      // 1. Gather active Solana mints (core catalog + top tokens from registry)
      const registry = await getJupiterTradableRegistry().catch(() => null)
      const catalogMints = SOL_DEX_CATALOG.map((t) => ({ mint: t.mint, symbol: t.binanceSymbol }))
      const registryMints = (registry?.tokens ?? []).slice(0, 30).map((t) => ({
        mint: t.mint,
        symbol: t.binanceSymbol,
      }))

      const tokenMap = new Map<string, string>()
      for (const t of [...catalogMints, ...registryMints]) {
        if (t.mint && t.symbol && !tokenMap.has(t.mint)) {
          tokenMap.set(t.mint, t.symbol)
        }
      }

      const mints = Array.from(tokenMap.keys())
      if (mints.length === 0) return

      // 2. Fetch fresh prices directly from Jupiter Price API v3
      const prices = await fetchJupiterPricesV3(mints)

      const ticks: JupiterPriceTick[] = []
      for (const [mint, quote] of prices.entries()) {
        const symbol = tokenMap.get(mint)
        if (!symbol || !quote.usdPrice || quote.usdPrice <= 0) continue

        const prevPrice = previousPrices.get(symbol)
        if (prevPrice !== quote.usdPrice) {
          previousPrices.set(symbol, quote.usdPrice)
          ticks.push({
            symbol,
            mint,
            lastPrice: quote.usdPrice,
            priceChangePercent: quote.priceChange24h ?? 0,
          })
        }
      }

      // 3. Publish lightweight real-time tick if any price shifted
      if (ticks.length > 0) {
        pubsub.publish('jupiter:ticker', ticks)
      }

      // 4. Periodically (every ~20s / 10 ticks), refresh full 1500-pair board
      if (fullBoardCycleCounter >= 10) {
        fullBoardCycleCounter = 0
        void getJupiterLiveMarketBoard(1500).catch(() => null)
      }
    } catch (err) {
      logger.warn({ err }, '[jupiterTicker] tick stream error')
    }
  }, 2_000)
}
