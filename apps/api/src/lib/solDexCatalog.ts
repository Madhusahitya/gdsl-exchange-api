/**
 * Solana token catalog for DEX Jupiter — mint addresses on mainnet-beta.
 * Live prices from Jupiter Price API v3; swaps via Jupiter Swap API v2 on Solana.
 */
export type SolDexToken = {
  baseSymbol: string
  binanceSymbol: string
  mint: string
  decimals: number
  name: string
  /** Optional Jupiter Tokens API v2 enrichment (set during discovery, not for static catalog). */
  usdPrice?: number
  liquidityUsd?: number
  volume24hUsd?: number
  priceChange24h?: number
  /** True when this token also trades on Binance (enables Binance-shaped chart). */
  hasBinance?: boolean
  icon?: string
  organicScore?: number
}

/** Native SOL mint (wrapped SOL in Jupiter routes). */
export const SOL_NATIVE_MINT = 'So11111111111111111111111111111111111111112'
/** USDC — primary quote stable on Solana Jupiter routes. */
export const SOL_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

export const SOL_DEX_CATALOG: SolDexToken[] = [
  { baseSymbol: 'SOL', binanceSymbol: 'SOLUSDT', mint: SOL_NATIVE_MINT, decimals: 9, name: 'SOL' },
  {
    baseSymbol: 'BTC',
    binanceSymbol: 'BTCUSDT',
    mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
    decimals: 8,
    name: 'WBTC (Portal)',
  },
  {
    baseSymbol: 'ETH',
    binanceSymbol: 'ETHUSDT',
    mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    decimals: 8,
    name: 'ETH (Portal)',
  },
  {
    baseSymbol: 'LINK',
    binanceSymbol: 'LINKUSDT',
    mint: 'LinkhB3afbBKb2EQQu7s7umdZceV3wcvAUJhQAfQ23L',
    decimals: 9,
    name: 'LINK',
  },
  {
    baseSymbol: 'JUP',
    binanceSymbol: 'JUPUSDT',
    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    decimals: 6,
    name: 'JUP',
  },
  {
    baseSymbol: 'BONK',
    binanceSymbol: 'BONKUSDT',
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    decimals: 5,
    name: 'BONK',
  },
  {
    baseSymbol: 'RAY',
    binanceSymbol: 'RAYUSDT',
    mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    decimals: 6,
    name: 'RAY',
  },
  {
    baseSymbol: 'TRX',
    binanceSymbol: 'TRXUSDT',
    mint: 'GbbesPbaYh5uiAZSYNXTc7w9jty1rpg3P9L4JeN4LkKc',
    decimals: 6,
    name: 'TRON (Solana)',
  },
]

/** Extra base symbols probed via Jupiter search (BSC overlap + liquid Solana memecoins). */
export const SOL_DEX_SEED_BASE_SYMBOLS = [
  'BNB',
  'USDC',
  'USDT',
  'XRP',
  'DOGE',
  'ADA',
  'DOT',
  'AVAX',
  'MATIC',
  'POL',
  'NEAR',
  'LTC',
  'TRX',
  'SHIB',
  'PEPE',
  'UNI',
  'AAVE',
  'APT',
  'SUI',
  'TIA',
  'INJ',
  'FET',
  'ONDO',
  'HBAR',
  'XLM',
  'FIL',
  'ATOM',
  'RAY',
  'PYTH',
  'RENDER',
  'ORCA',
  'TRUMP',
  'WIF',
  'BONK',
  'JUP',
  'SOL',
  'BTC',
  'ETH',
  'LINK',
]

const BY_BINANCE = new Map(SOL_DEX_CATALOG.map((t) => [t.binanceSymbol, t]))

export const SOL_TOKEN_BINANCE_BY_SYMBOL: Record<string, string> = Object.fromEntries(
  SOL_DEX_CATALOG.map((t) => [t.baseSymbol, t.binanceSymbol]),
)

export function catalogSolTokenForBinanceSymbol(binanceSymbol: string): SolDexToken | null {
  return BY_BINANCE.get(binanceSymbol.toUpperCase()) ?? null
}

export function listSolCatalogBinanceSymbols(): string[] {
  return SOL_DEX_CATALOG.map((t) => t.binanceSymbol)
}
