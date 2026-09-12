export type BinanceFilter =
  | {
      filterType: 'LOT_SIZE'
      minQty: string
      maxQty: string
      stepSize: string
    }
  | {
      filterType: 'MARKET_LOT_SIZE'
      minQty: string
      maxQty: string
      stepSize: string
    }
  | {
      filterType: 'MIN_NOTIONAL'
      minNotional: string
    }
  | {
      filterType: 'NOTIONAL'
      minNotional: string
    }
  | { filterType: string; [k: string]: unknown }

export type BinanceSymbolInfo = {
  symbol: string
  status: string
  baseAsset: string
  quoteAsset: string
  filters: BinanceFilter[]
}

export type ExchangeInfoResponse = {
  symbols: BinanceSymbolInfo[]
}

export type AccountBalance = {
  asset: string
  free: string
  locked: string
}

export type AccountResponse = {
  balances: AccountBalance[]
}
