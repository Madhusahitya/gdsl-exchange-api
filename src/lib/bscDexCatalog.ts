/**
 * BSC token catalog for DEX 1inch — standalone (no personalWalletService import).
 * Binance-Peg addresses on BSC mainnet.
 */
export type BscDexToken = {
  baseSymbol: string
  binanceSymbol: string
  address: `0x${string}`
  decimals: number
  name: string
}

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as const

export const BSC_DEX_CATALOG: BscDexToken[] = [
  { baseSymbol: 'BNB', binanceSymbol: 'BNBUSDT', address: NATIVE, decimals: 18, name: 'BNB' },
  {
    baseSymbol: 'USDC',
    binanceSymbol: 'USDCUSDT',
    address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    decimals: 18,
    name: 'USDC',
  },
  {
    baseSymbol: 'BTC',
    binanceSymbol: 'BTCUSDT',
    address: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c',
    decimals: 18,
    name: 'BTCB',
  },
  {
    baseSymbol: 'ETH',
    binanceSymbol: 'ETHUSDT',
    address: '0x2170ed0880ac9a755fd29b2688956bd959f933f8',
    decimals: 18,
    name: 'ETH',
  },
  {
    baseSymbol: 'XRP',
    binanceSymbol: 'XRPUSDT',
    address: '0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe',
    decimals: 18,
    name: 'XRP',
  },
  {
    baseSymbol: 'DOGE',
    binanceSymbol: 'DOGEUSDT',
    address: '0xba2ae424d960c26247dd6c32edc70b295c744c43',
    decimals: 8,
    name: 'DOGE',
  },
  {
    baseSymbol: 'SOL',
    binanceSymbol: 'SOLUSDT',
    address: '0x570a5d26f7765ecb712c0924e4de545b89fd43df',
    decimals: 18,
    name: 'SOL',
  },
  {
    baseSymbol: 'LINK',
    binanceSymbol: 'LINKUSDT',
    address: '0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd',
    decimals: 18,
    name: 'LINK',
  },
  {
    baseSymbol: 'ADA',
    binanceSymbol: 'ADAUSDT',
    address: '0x3ee2200efb3400fabb9aacf31297cbdd1d435d47',
    decimals: 18,
    name: 'ADA',
  },
  {
    baseSymbol: 'DOT',
    binanceSymbol: 'DOTUSDT',
    address: '0x7083609fce4d1d8dc0c979aab8c869ea2c873402',
    decimals: 18,
    name: 'DOT',
  },
  {
    baseSymbol: 'AVAX',
    binanceSymbol: 'AVAXUSDT',
    address: '0x1ce0c2827e2ef14d5c4f29a091d735a204794041',
    decimals: 18,
    name: 'AVAX',
  },
  {
    baseSymbol: 'MATIC',
    binanceSymbol: 'MATICUSDT',
    address: '0xcc42724c6683b7e57334c4e856f4c9965ed682bd',
    decimals: 18,
    name: 'MATIC',
  },
  {
    baseSymbol: 'NEAR',
    binanceSymbol: 'NEARUSDT',
    address: '0x1fa4a73a3f0133f0025378af00236f3abdee5d63',
    decimals: 18,
    name: 'NEAR',
  },
  {
    baseSymbol: 'LTC',
    binanceSymbol: 'LTCUSDT',
    address: '0x4338665cbb7b2485a8855a139b75d5e34ab0db94',
    decimals: 18,
    name: 'LTC',
  },
  {
    baseSymbol: 'FDUSD',
    binanceSymbol: 'FDUSDUSDT',
    address: '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409',
    decimals: 18,
    name: 'FDUSD',
  },
]

const BY_BINANCE = new Map(BSC_DEX_CATALOG.map((t) => [t.binanceSymbol, t]))

export function catalogTokenForBinanceSymbol(binanceSymbol: string): BscDexToken | null {
  return BY_BINANCE.get(binanceSymbol.toUpperCase()) ?? null
}

export function listCatalogBinanceSymbols(): string[] {
  return BSC_DEX_CATALOG.map((t) => t.binanceSymbol)
}
