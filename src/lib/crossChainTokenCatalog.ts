/**
 * BSC ↔ Solana same-token cross-chain pairs (LI.FI bridge settlement).
 * Joins Binance-Peg BSC assets with Portal/wrapped Solana mints by binanceSymbol.
 */
import { BSC_DEX_CATALOG } from './bscDexCatalog'
import { SOL_DEX_CATALOG, SOL_NATIVE_MINT, SOL_USDC_MINT } from './solDexCatalog'

/** BSC USDT — in personal wallet but omitted from BSC_DEX_CATALOG. */
const BSC_USDT_ADDRESS = '0x55d398326f99059ff775485246999027b3197955' as const

export type CrossChainBscLeg = {
  symbol: string
  address: `0x${string}` | null
  decimals: number
  native: boolean
  binanceSymbol: string
}

export type CrossChainSolLeg = {
  symbol: string
  mint: string
  decimals: number
  native: boolean
  binanceSymbol: string
}

export type CrossChainPair = {
  canonicalSymbol: string
  bsc: CrossChainBscLeg
  sol: CrossChainSolLeg
}

/** User-facing symbol aliases (wallet uses BTCB, DEX uses BTC). */
const SYMBOL_ALIASES: Record<string, string> = {
  BTCB: 'BTC',
  WBNB: 'BNB',
}

/** Sol mints for stables not in SOL_DEX_CATALOG static list. */
const EXTRA_SOL_MINTS: Record<string, { mint: string; decimals: number; binanceSymbol: string }> = {
  USDT: { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6, binanceSymbol: 'USDTUSDT' },
}

function normalizeSymbol(raw: string): string {
  const u = raw.toUpperCase()
  return SYMBOL_ALIASES[u] ?? u
}

export function bscLegForSymbol(canonical: string): CrossChainBscLeg | null {
  if (canonical === 'BNB') {
    return { symbol: 'BNB', address: null, decimals: 18, native: true, binanceSymbol: 'BNBUSDT' }
  }
  if (canonical === 'USDT') {
    return {
      symbol: 'USDT',
      address: BSC_USDT_ADDRESS,
      decimals: 18,
      native: false,
      binanceSymbol: 'USDTUSDT',
    }
  }
  const dex = BSC_DEX_CATALOG.find((t) => t.baseSymbol === canonical || (canonical === 'BTC' && t.baseSymbol === 'BTC'))
  if (!dex) return null
  return {
    symbol: canonical,
    address: dex.address,
    decimals: dex.decimals,
    native: false,
    binanceSymbol: dex.binanceSymbol,
  }
}

export function solLegForSymbol(canonical: string): CrossChainSolLeg | null {
  if (canonical === 'SOL') {
    return { symbol: 'SOL', mint: SOL_NATIVE_MINT, decimals: 9, native: true, binanceSymbol: 'SOLUSDT' }
  }
  if (canonical === 'USDC') {
    return { symbol: 'USDC', mint: SOL_USDC_MINT, decimals: 6, native: false, binanceSymbol: 'USDCUSDT' }
  }
  const extra = EXTRA_SOL_MINTS[canonical]
  if (extra) {
    return { symbol: canonical, mint: extra.mint, decimals: extra.decimals, native: false, binanceSymbol: extra.binanceSymbol }
  }
  const cat = SOL_DEX_CATALOG.find((t) => t.baseSymbol === canonical)
  if (!cat) return null
  return {
    symbol: canonical,
    mint: cat.mint,
    decimals: cat.decimals,
    native: false,
    binanceSymbol: cat.binanceSymbol,
  }
}

/** Static pairs where both chain legs are known. */
export function buildCrossChainPair(canonical: string): CrossChainPair | null {
  const sym = normalizeSymbol(canonical)
  const bsc = bscLegForSymbol(sym)
  const sol = solLegForSymbol(sym)
  if (!bsc || !sol) return null
  return { canonicalSymbol: sym, bsc, sol }
}

export function isSameTokenCrossChainSupported(symbol: string): boolean {
  return buildCrossChainPair(symbol) != null
}

export function listCrossChainSupportedSymbols(): string[] {
  const symbols = new Set<string>()
  for (const t of BSC_DEX_CATALOG) {
    if (buildCrossChainPair(t.baseSymbol)) symbols.add(t.baseSymbol)
  }
  if (buildCrossChainPair('USDT')) symbols.add('USDT')
  if (buildCrossChainPair('BTCB')) symbols.add('BTC')
  return [...symbols].sort()
}

export function resolveCrossChainPair(symbol: string): CrossChainPair {
  const pair = buildCrossChainPair(toCanonicalCrossChainSymbol(symbol))
  if (!pair) {
    throw new Error(
      `${normalizeSymbol(symbol)} is not supported for same-token cross-chain yet. Try USDC, ETH, BTC, SOL, or LINK.`,
    )
  }
  return pair
}

/** Map wallet symbol (e.g. BTCB) to canonical cross-chain symbol. */
export function toCanonicalCrossChainSymbol(symbol: string): string {
  return normalizeSymbol(symbol)
}

export type CrossChainChain = 'BSC' | 'SOL'

/** Resolve a token leg on a specific chain (for cross-token routes). */
export function crossChainLegForChain(
  symbol: string,
  chain: CrossChainChain,
): CrossChainBscLeg | CrossChainSolLeg | null {
  const canonical = toCanonicalCrossChainSymbol(symbol)
  return chain === 'BSC' ? bscLegForSymbol(canonical) : solLegForSymbol(canonical)
}

/**
 * A cross-token route: source token on the source chain → destination token on
 * the destination chain. When source and destination canonical symbols match,
 * this is the classic same-token bridge (`sameToken: true`).
 */
export type CrossChainRoute = {
  direction: 'BSC_TO_SOL' | 'SOL_TO_BSC'
  sourceSymbol: string
  destSymbol: string
  sameToken: boolean
  /** Leg on the source chain (the user debits this). */
  sourceLeg: CrossChainBscLeg | CrossChainSolLeg
  /** Leg on the destination chain (the user is credited this). */
  destLeg: CrossChainBscLeg | CrossChainSolLeg
  sourceChain: CrossChainChain
  destChain: CrossChainChain
}

export function resolveCrossChainRoute(
  direction: 'BSC_TO_SOL' | 'SOL_TO_BSC',
  sourceSymbol: string,
  destSymbol?: string,
): CrossChainRoute {
  const srcCanonical = toCanonicalCrossChainSymbol(sourceSymbol)
  const dstCanonical = toCanonicalCrossChainSymbol(destSymbol ?? sourceSymbol)
  const sourceChain: CrossChainChain = direction === 'BSC_TO_SOL' ? 'BSC' : 'SOL'
  const destChain: CrossChainChain = direction === 'BSC_TO_SOL' ? 'SOL' : 'BSC'

  const sourceLeg = crossChainLegForChain(srcCanonical, sourceChain)
  const destLeg = crossChainLegForChain(dstCanonical, destChain)
  if (!sourceLeg) {
    throw new Error(`${srcCanonical} is not supported on ${sourceChain} for cross-chain yet.`)
  }
  if (!destLeg) {
    throw new Error(`${dstCanonical} is not supported on ${destChain} for cross-chain yet.`)
  }
  return {
    direction,
    sourceSymbol: srcCanonical,
    destSymbol: dstCanonical,
    sameToken: srcCanonical === dstCanonical,
    sourceLeg,
    destLeg,
    sourceChain,
    destChain,
  }
}
