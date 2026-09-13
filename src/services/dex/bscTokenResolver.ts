/**
 * Resolve Binance USDT spot symbols → BSC ERC-20 addresses for 1inch Classic.
 */
import {
  catalogTokenForBinanceSymbol,
  type BscDexToken,
} from '../../lib/bscDexCatalog'
import { fetchOneInchTokenMap, isOneInchConfigured } from './oneInchClassicService'

export type ResolvedBscToken = {
  baseSymbol: string
  binanceSymbol: string
  contractAddress: `0x${string}`
  decimals: number
  name: string
  source: 'catalog' | 'oneinch'
}

const SYMBOL_ALIASES: Record<string, string> = {
  BTC: 'BTCB',
  WBNB: 'BNB',
}

function baseFromBinanceSymbol(binanceSymbol: string): string {
  return binanceSymbol.replace(/USDT$/i, '').toUpperCase()
}

function fromCatalog(binanceSymbol: string): ResolvedBscToken | null {
  const row = catalogTokenForBinanceSymbol(binanceSymbol)
  if (!row) return null
  return {
    baseSymbol: row.baseSymbol,
    binanceSymbol: row.binanceSymbol,
    contractAddress: row.address,
    decimals: row.decimals,
    name: row.name,
    source: 'catalog',
  }
}

async function fromOneInch(binanceSymbol: string): Promise<ResolvedBscToken | null> {
  if (!isOneInchConfigured()) return null
  const base = baseFromBinanceSymbol(binanceSymbol)
  const map = await fetchOneInchTokenMap()
  const direct = map.get(base)
  if (direct) {
    return {
      baseSymbol: base,
      binanceSymbol: binanceSymbol.toUpperCase(),
      contractAddress: direct.address,
      decimals: direct.decimals,
      name: direct.symbol,
      source: 'oneinch',
    }
  }
  const aliased = SYMBOL_ALIASES[base]
  if (aliased) {
    const alt = map.get(aliased)
    if (alt) {
      return {
        baseSymbol: base,
        binanceSymbol: binanceSymbol.toUpperCase(),
        contractAddress: alt.address,
        decimals: alt.decimals,
        name: alt.symbol,
        source: 'oneinch',
      }
    }
  }
  return null
}

export async function resolveBscTokenForBinanceSymbol(binanceSymbol: string): Promise<ResolvedBscToken | null> {
  const sym = binanceSymbol.toUpperCase()
  if (!/^[A-Z0-9]{2,28}USDT$/.test(sym)) return null
  return fromCatalog(sym) ?? (await fromOneInch(sym))
}

export function isValidBinanceUsdtSymbol(symbol: string): boolean {
  return /^[A-Z0-9]{2,28}USDT$/.test(symbol.toUpperCase())
}
