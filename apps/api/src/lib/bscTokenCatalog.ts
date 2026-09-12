/**
 * Shared BSC token catalog for DEX / personal wallet / equity marks.
 * Kept in a leaf module so equityService does not import personalWalletService
 * (avoids heavy module coupling and any risk of circular imports on boot).
 */
export type BscTokenCatalogEntry = {
  symbol: string
  binanceSymbol: string | null
}

/** Symbols the DEX personal-wallet book can hold (subset used for live marks). */
export const BSC_TOKEN_BINANCE_BY_SYMBOL: Record<string, string> = {
  BNB: 'BNBUSDT',
  BTCB: 'BTCUSDT',
  ETH: 'ETHUSDT',
  XRP: 'XRPUSDT',
  DOGE: 'DOGEUSDT',
  SOL: 'SOLUSDT',
  LINK: 'LINKUSDT',
  ADA: 'ADAUSDT',
  DOT: 'DOTUSDT',
  AVAX: 'AVAXUSDT',
  MATIC: 'MATICUSDT',
  LTC: 'LTCUSDT',
  NEAR: 'NEARUSDT',
}
