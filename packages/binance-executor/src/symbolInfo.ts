import type { BinanceSymbolInfo } from './types'

/** Lot / notional rules for sizing and validation */
export type ParsedSymbolRules = {
  symbol: string
  baseAsset: string
  quoteAsset: string
  /** Prefer MARKET_LOT_SIZE for MARKET orders when present */
  lot: { minQty: string; maxQty: string; stepSize: string }
  minNotional: number
}

function pickLotSize(filters: BinanceSymbolInfo['filters']): {
  minQty: string
  maxQty: string
  stepSize: string
} {
  const market = filters.find((f) => f.filterType === 'MARKET_LOT_SIZE')
  const lot = filters.find((f) => f.filterType === 'LOT_SIZE')
  const src = market ?? lot
  if (!src || !('minQty' in src)) {
    throw new Error('Symbol missing LOT_SIZE / MARKET_LOT_SIZE filters')
  }
  return {
    minQty: String(src.minQty),
    maxQty: String(src.maxQty),
    stepSize: String(src.stepSize),
  }
}

function pickMinNotional(filters: BinanceSymbolInfo['filters']): number {
  for (const f of filters) {
    if (f.filterType === 'NOTIONAL' && 'minNotional' in f) {
      return parseFloat(String(f.minNotional))
    }
    if (f.filterType === 'MIN_NOTIONAL' && 'minNotional' in f) {
      return parseFloat(String(f.minNotional))
    }
  }
  return 0
}

export function parseSymbolRules(raw: BinanceSymbolInfo): ParsedSymbolRules {
  return {
    symbol: raw.symbol,
    baseAsset: raw.baseAsset,
    quoteAsset: raw.quoteAsset,
    lot: pickLotSize(raw.filters),
    minNotional: pickMinNotional(raw.filters),
  }
}
