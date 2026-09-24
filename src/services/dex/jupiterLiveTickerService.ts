/**
 * Real-time price ticker service for Solana / Jupiter markets.
 *
 * Runs a fast 1-second ticker loop with RAM book-mid integration for SOL
 * and broadcasts lightweight real-time price diffs to all connected WebSocket clients.
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
import { fetchBinanceBookMid } from './jupiterMarkService'
import { orderBookService, orderBookEmitter, type LiveBookTicker } from '../market/orderBook'

export type JupiterPriceTick = {
  symbol: string
  mint: string
  lastPrice: number
  priceChangePercent: number
}

let tickerInterval: NodeJS.Timeout | null = null
let fullBoardCycleCounter = 0
const previousPrices = new Map<string, number>()
const latestTicksCache = new Map<string, JupiterPriceTick>()

export function getLatestJupiterTicks(): JupiterPriceTick[] {
  return Array.from(latestTicksCache.values())
}

const solMint = 'So11111111111111111111111111111111111111112'
const coreMintMap: Record<string, string> = {
  SOLUSDT: solMint,
  BTCUSDT: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
  ETHUSDT: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
}

let lastFastPushTime = 0
let bridgeInitialized = false

function setupReactiveBookTickerBridge(): void {
  if (bridgeInitialized) return
  bridgeInitialized = true

  orderBookEmitter.on('bookTicker', (tick: LiveBookTicker) => {
    try {
      const io = getSocketIo()
      if (!io || io.engine.clientsCount === 0) return

      const mint = coreMintMap[tick.symbol]
      if (!mint) return

      const now = Date.now()
      // Throttle to 150ms per symbol for buttery-smooth sub-second updates without socket flood
      if (now - lastFastPushTime < 150) return

      const prev = previousPrices.get(tick.symbol)
      if (prev !== tick.mid) {
        lastFastPushTime = now
        previousPrices.set(tick.symbol, tick.mid)
        const item: JupiterPriceTick = {
          symbol: tick.symbol,
          mint,
          lastPrice: tick.mid,
          priceChangePercent: latestTicksCache.get(tick.symbol)?.priceChangePercent ?? 0,
        }
        latestTicksCache.set(tick.symbol, item)
        pubsub.publish('jupiter:ticker', [item])
      }
    } catch {
      /* ignore */
    }
  })
}

export function startJupiterLiveTicker(): void {
  setupReactiveBookTickerBridge()
  if (tickerInterval) return

  logger.info('[jupiterTicker] starting high-speed real-time price ticker stream')

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

      // 2a. Real-time ultra-fast spot reference for SOLUSDT (via RAM depth / Binance bookTicker)
      const solMint = 'So11111111111111111111111111111111111111112'
      try {
        const solDepth = await orderBookService.getDepth('SOLUSDT').catch(() => null)
        const fastSolPrice =
          solDepth?.mid && solDepth.mid > 0
            ? solDepth.mid
            : await fetchBinanceBookMid('SOLUSDT').catch(() => null)

        if (fastSolPrice && fastSolPrice > 0) {
          const prevPrice = previousPrices.get('SOLUSDT')
          if (prevPrice !== fastSolPrice) {
            previousPrices.set('SOLUSDT', fastSolPrice)
            const tick: JupiterPriceTick = {
              symbol: 'SOLUSDT',
              mint: solMint,
              lastPrice: fastSolPrice,
              priceChangePercent: prices.get(solMint)?.priceChange24h ?? 0,
            }
            ticks.push(tick)
            latestTicksCache.set('SOLUSDT', tick)
          }
        }
      } catch {
        /* fallback to Jupiter v3 */
      }

      // 2b. Map all other Jupiter tokens
      for (const [mint, quote] of prices.entries()) {
        const symbol = tokenMap.get(mint)
        if (!symbol || !quote.usdPrice || quote.usdPrice <= 0) continue
        if (symbol === 'SOLUSDT' && ticks.some((t) => t.symbol === 'SOLUSDT')) continue

        const prevPrice = previousPrices.get(symbol)
        if (prevPrice !== quote.usdPrice) {
          previousPrices.set(symbol, quote.usdPrice)
          const tick: JupiterPriceTick = {
            symbol,
            mint,
            lastPrice: quote.usdPrice,
            priceChangePercent: quote.priceChange24h ?? 0,
          }
          ticks.push(tick)
          latestTicksCache.set(symbol, tick)
        }
      }

      // 3. Publish lightweight real-time tick if any price shifted
      if (ticks.length > 0) {
        pubsub.publish('jupiter:ticker', ticks)
      }

      // 4. Periodically (every ~20s / 20 ticks @ 1s), refresh full 1500-pair board
      if (fullBoardCycleCounter >= 20) {
        fullBoardCycleCounter = 0
        void getJupiterLiveMarketBoard(1500).catch(() => null)
      }
    } catch (err) {
      logger.warn({ err }, '[jupiterTicker] tick stream error')
    }
  }, 1_000)
}

