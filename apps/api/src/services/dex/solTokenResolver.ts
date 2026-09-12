import {
  catalogSolTokenForBinanceSymbol,
  SOL_USDC_MINT,
  type SolDexToken,
} from '../../lib/solDexCatalog'
import { getJupiterOrder, isJupiterConfigured } from './jupiterClassicService'
import { env } from '../../lib/env'

export type ResolvedSolToken = SolDexToken & {
  source: 'catalog' | 'search'
  /** True for Solana-native tokens with no matching Binance spot pair. */
  native?: boolean
  /** 24h traded volume in USD (from Jupiter top-traded stats), when known. */
  volume24hUsd?: number
  /** Pool liquidity in USD, when known. */
  liquidityUsd?: number
  /** Token logo URL, when known. */
  iconUrl?: string | null
}

const BINANCE_RE = /^[A-Z0-9]{2,28}USDT$/

export function isValidBinanceUsdtSymbol(s: string): boolean {
  return BINANCE_RE.test(s.toUpperCase())
}

async function searchJupiterMint(baseSymbol: string): Promise<ResolvedSolToken | null> {
  const key = env.JUPITER_API_KEY?.trim()
  if (!key) return null
  const q = baseSymbol.toUpperCase()
  try {
    const url = `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(q)}`
    const res = await fetch(url, {
      headers: { 'x-api-key': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const list = (await res.json()) as Array<{
      id?: string
      symbol?: string
      name?: string
      decimals?: number
      isVerified?: boolean
      tags?: string[]
    }>
    const hit =
      list.find(
        (t) =>
          t.symbol?.toUpperCase() === q &&
          (t.isVerified || t.tags?.includes('verified') || t.tags?.includes('major')),
      ) ??
      list.find((t) => t.symbol?.toUpperCase() === q) ??
      list.find((t) => t.name?.toUpperCase().includes(q))
    if (!hit?.id || hit.decimals == null) return null
    return {
      baseSymbol: q,
      binanceSymbol: `${q}USDT`,
      mint: hit.id,
      decimals: hit.decimals,
      name: hit.name ?? q,
      source: 'search',
    }
  } catch {
    return null
  }
}

/** Quick Jupiter USDC→token probe (50 USDC notional). */
async function jupiterBuyRouteOk(mint: string): Promise<boolean> {
  if (!isJupiterConfigured()) return false
  try {
    const order = await getJupiterOrder({
      inputMint: SOL_USDC_MINT,
      outputMint: mint,
      amount: '50000000',
    })
    return BigInt(order.outAmount || '0') > 0n
  } catch {
    return false
  }
}

export async function resolveSolTokenForBinanceSymbol(
  binanceSymbol: string,
  opts?: { requireLiveRoute?: boolean },
): Promise<ResolvedSolToken | null> {
  const requireRoute = opts?.requireLiveRoute !== false
  const sym = binanceSymbol.toUpperCase()
  const catalog = catalogSolTokenForBinanceSymbol(sym)
  if (catalog && (!requireRoute || (await jupiterBuyRouteOk(catalog.mint)))) {
    return { ...catalog, source: 'catalog' }
  }
  if (!isJupiterConfigured()) return catalog ? { ...catalog, source: 'catalog' } : null
  const base = sym.replace(/USDT$/i, '')
  const searched = await searchJupiterMint(base)
  if (searched && (!requireRoute || (await jupiterBuyRouteOk(searched.mint)))) return searched
  return null
}
