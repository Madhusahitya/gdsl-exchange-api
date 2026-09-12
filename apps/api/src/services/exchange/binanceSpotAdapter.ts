/**
 * BinanceSpotAdapter — thin ChainAdapter-shaped wrapper around the existing
 * Binance CEX stack. Does NOT replace liveTradingBot or binanceAdapter;
 * it standardizes quote/balance/sizing so Deploy $X and multi-venue ranking
 * can treat CEX as a peer of Jupiter later.
 *
 * Jupiter Super Machine paths are intentionally untouched.
 */
import { binanceAdapter } from './binanceAdapter'
import { computeLiveOrderSize, type LiveOrderSizeResult } from './liveOrderSizing'
import { fetchBookTicker } from '../trading/binanceSpotQuoteService'

export const BINANCE_SPOT_ADAPTER_ID = 'binance-spot' as const

export type VenueClass = 'cex' | 'dex'

export type AdapterQuote = {
  adapterId: typeof BINANCE_SPOT_ADAPTER_ID
  venueClass: VenueClass
  symbol: string
  bid: number | null
  ask: number | null
  mid: number | null
  /** CEX has no DEX "router" — the order book IS the venue. */
  routerRole: 'order_book'
  explanation: string
}

export type AdapterBalance = {
  asset: string
  free: number
  locked: number
}

/**
 * How CEX "routing" works vs Jupiter:
 * - Jupiter: compare Metis / Raydium / Orca / … routers → pick best swap path
 * - Binance: one venue; "route quality" = book depth, spread, fee tier, fill probability
 */
export class BinanceSpotAdapter {
  readonly id = BINANCE_SPOT_ADAPTER_ID
  readonly venueClass: VenueClass = 'cex'
  readonly label = 'Binance Spot'

  toSymbol(pair: string): string {
    return pair.replace('/', '').toUpperCase()
  }

  async getBalances(apiKey: string, apiSecret: string): Promise<AdapterBalance[]> {
    const rows = await binanceAdapter.getBalances(apiKey, apiSecret)
    return rows.map((b) => ({
      asset: b.asset,
      free: Number(b.free) || 0,
      locked: Number(b.locked) || 0,
    }))
  }

  async getFreeUsdt(apiKey: string, apiSecret: string): Promise<number> {
    const balances = await this.getBalances(apiKey, apiSecret)
    const usdt = balances.find((b) => b.asset === 'USDT')
    return usdt?.free ?? 0
  }

  async getQuote(pairOrSymbol: string): Promise<AdapterQuote> {
    const symbol = this.toSymbol(pairOrSymbol)
    const book = await fetchBookTicker(symbol)
    const bid = book?.bid ?? null
    const ask = book?.ask ?? null
    const mid =
      bid != null && ask != null && bid > 0 && ask > 0 ? (bid + ask) / 2 : (bid ?? ask ?? null)
    const spreadBps =
      bid != null && ask != null && mid != null && mid > 0
        ? Math.round(((ask - bid) / mid) * 10_000 * 10) / 10
        : null

    return {
      adapterId: this.id,
      venueClass: this.venueClass,
      symbol,
      bid,
      ask,
      mid,
      routerRole: 'order_book',
      explanation:
        spreadBps != null
          ? `Binance spot order book · spread ~${spreadBps} bps · no DEX router (direct CEX fill)`
          : 'Binance spot order book · quote unavailable',
    }
  }

  sizeLiveOrder(input: {
    freeUsdt: number
    tradeSizePct: number
    requestedOrderSizeUsdt?: number | null
    maxOrderNotional?: number | null
    envMaxOrderUsdt?: number | null
  }): LiveOrderSizeResult {
    return computeLiveOrderSize(input)
  }

  describe(): {
    id: string
    venueClass: VenueClass
    label: string
    routerModel: string
    vsJupiter: string
  } {
    return {
      id: this.id,
      venueClass: this.venueClass,
      label: this.label,
      routerModel:
        'CEX order book — market/limit orders hit Binance matching engine (not Jupiter/1inch routers).',
      vsJupiter:
        'Compare net edge after fees/slippage: Binance for liquid majors; Jupiter for Solana DEX-native flow.',
    }
  }
}

export const binanceSpotAdapter = new BinanceSpotAdapter()
