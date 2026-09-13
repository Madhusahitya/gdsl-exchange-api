/**
 * Live exit marks for DEX 1inch BSC positions — USDT per token from a 1inch sell quote.
 */
import { formatUnits, parseUnits } from 'ethers'
import { BSC_TOKEN_BINANCE_BY_SYMBOL } from '../../lib/bscTokenCatalog'
import {
  getOneInchQuote,
  isOneInchConfigured,
  ONEINCH_NATIVE,
  ONEINCH_USDT,
} from './oneInchClassicService'
import { resolveBscTokenForBinanceSymbol } from './bscTokenResolver'

const BINANCE_REST = 'https://api.binance.com'
const markCache = new Map<string, { price: number; ts: number }>()
const MARK_TTL_MS = 8_000

async function fetchBinanceMid(binanceSymbol: string): Promise<number | null> {
  try {
    const res = await fetch(`${BINANCE_REST}/api/v3/ticker/price?symbol=${encodeURIComponent(binanceSymbol)}`)
    if (!res.ok) return null
    const data = (await res.json()) as { price?: string }
    const p = data.price ? parseFloat(data.price) : NaN
    return Number.isFinite(p) && p > 0 ? p : null
  } catch {
    return null
  }
}

/** Representative sell size for a mark quote (avoids huge API amounts on large bags). */
function quoteSellQty(positionQty: number, binanceMid: number | null): number {
  if (positionQty <= 0) return 0.0001
  const minUsd = 8
  const minQty =
    binanceMid != null && binanceMid > 0 ? minUsd / binanceMid : positionQty * 0.05
  const slice = Math.max(minQty, positionQty * 0.03)
  return Math.min(positionQty, slice)
}

/**
 * Estimated USDT received per 1 base token if sold now via 1inch (sell quote).
 */
export async function quoteOneInchSellUsdPerToken(
  baseSymbol: string,
  positionQty: number,
): Promise<number | null> {
  if (!isOneInchConfigured()) return null
  const sym = baseSymbol.toUpperCase()
  const cached = markCache.get(sym)
  if (cached && Date.now() - cached.ts < MARK_TTL_MS) return cached.price

  const binanceSym = BSC_TOKEN_BINANCE_BY_SYMBOL[sym]
  if (!binanceSym) return null
  const token = await resolveBscTokenForBinanceSymbol(binanceSym)
  if (!token) return null

  const binanceMid = await fetchBinanceMid(binanceSym)
  const sellQty = quoteSellQty(positionQty, binanceMid)
  if (sellQty <= 0) return null

  try {
    const frac = Math.min(8, token.decimals)
    const amountWei = parseUnits(sellQty.toFixed(frac), token.decimals)
    const src =
      token.contractAddress.toLowerCase() === ONEINCH_NATIVE.toLowerCase()
        ? ONEINCH_NATIVE
        : token.contractAddress
    const q = await getOneInchQuote({
      src,
      dst: ONEINCH_USDT,
      amount: amountWei.toString(),
    })
    const usdtOut = Number(formatUnits(BigInt(q.dstAmount), 18))
    const price = usdtOut / sellQty
    if (!Number.isFinite(price) || price <= 0) return null
    markCache.set(sym, { price, ts: Date.now() })
    return price
  } catch {
    return null
  }
}
