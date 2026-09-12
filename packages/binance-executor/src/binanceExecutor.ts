import type { ExecutorConfig } from './config'
import { BinanceHttpClient } from './httpClient'
import type { AccountResponse, ExchangeInfoResponse } from './types'
import { parseSymbolRules, type ParsedSymbolRules } from './symbolInfo'
import { assertMinNotionalMet, assertValidQuantityForSymbol } from './validation'

export type OrderSide = 'BUY' | 'SELL'

export type MarketOrderResult = {
  orderId: number | string
  status?: string
  symbol: string
  side: string
  executedQty?: string
  cummulativeQuoteQty?: string
  [k: string]: unknown
}

export class BinanceExecutor {
  private readonly http: BinanceHttpClient

  constructor(private readonly cfg: ExecutorConfig) {
    this.http = new BinanceHttpClient(cfg)
  }

  /** Free balances per asset (numeric). */
  async getAccountBalance(): Promise<Record<string, number>> {
    const acc = await this.http.signedRequest<AccountResponse>('/api/v3/account', new URLSearchParams(), 'GET')
    const out: Record<string, number> = {}
    for (const b of acc.balances) {
      out[b.asset] = parseFloat(b.free)
    }
    return out
  }

  /** Parsed trading rules for symbol (LOT_SIZE / MARKET_LOT_SIZE, minNotional). */
  async getSymbolInfo(symbol: string): Promise<ParsedSymbolRules> {
    const sym = symbol.toUpperCase()
    const data = await this.http.publicGet<ExchangeInfoResponse>('/api/v3/exchangeInfo', { symbol: sym })
    const row = data.symbols.find((s) => s.symbol === sym)
    if (!row || row.status !== 'TRADING') {
      throw new Error(`Symbol ${sym} not trading or not found`)
    }
    return parseSymbolRules(row)
  }

  async getLastPrice(symbol: string): Promise<number> {
    const sym = symbol.toUpperCase()
    const row = await this.http.publicGet<{ symbol: string; price: string }>('/api/v3/ticker/price', { symbol: sym })
    return parseFloat(row.price)
  }

  /**
   * MARKET order with base-asset quantity.
   * Validates minQty, maxQty, stepSize precision, and minNotional against last price before submit.
   */
  async placeMarketOrder(symbol: string, side: OrderSide, quantity: string): Promise<MarketOrderResult> {
    const sym = symbol.toUpperCase()
    const [rules, refPrice] = await Promise.all([this.getSymbolInfo(sym), this.getLastPrice(sym)])
    assertValidQuantityForSymbol(quantity, rules)
    assertMinNotionalMet(quantity, refPrice, rules)

    const clientId = `cex${Date.now()}${Math.random().toString(36).slice(2, 10)}`.slice(0, 32)
    const params = new URLSearchParams({
      symbol: sym,
      side,
      type: 'MARKET',
      quantity,
      newClientOrderId: clientId,
    })
    return this.http.signedRequest<MarketOrderResult>('/api/v3/order', params, 'POST')
  }
}

export function createBinanceExecutor(cfg: ExecutorConfig): BinanceExecutor {
  return new BinanceExecutor(cfg)
}
