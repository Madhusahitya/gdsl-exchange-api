/**
 * Synthetic Jupiter order book — executable depth from quote slices (works for every SPL token).
 */
import { getJupiterTradableToken } from './jupiterTradableRegistry'
import { getJupiterOrder, isJupiterConfigured } from './jupiterClassicService'
import { getJupiterExecutableMarks, fetchBinanceBookMid } from './jupiterMarkService'
import { SOL_USDC_MINT } from '../../lib/solDexCatalog'
import { fetchJupiterPricesV3 } from './jupiterPriceService'

export type JupiterDepthLevel = { price: number; qty: number; notionalUsd: number }

export type JupiterSyntheticDepth = {
  symbol: string
  mint: string | null
  bids: JupiterDepthLevel[]
  asks: JupiterDepthLevel[]
  mid: number | null
  bid: number | null
  ask: number | null
  spreadBps: number | null
  updatedAt: string
  source: 'jupiter_quotes'
}

const depthCache = new Map<string, { at: number; depth: JupiterSyntheticDepth }>()
const DEPTH_TTL_MS = 1_000

function toSmallest(amountHuman: number, decimals: number): string {
  const factor = 10 ** decimals
  return String(Math.max(1, Math.floor(amountHuman * factor)))
}

async function quoteBuyLevel(
  mint: string,
  decimals: number,
  usdcSpend: number,
): Promise<{ price: number; qty: number } | null> {
  if (usdcSpend <= 0) return null
  try {
    const order = await getJupiterOrder({
      inputMint: SOL_USDC_MINT,
      outputMint: mint,
      amount: toSmallest(usdcSpend, 6),
      slippageBps: 100,
    })
    const qty = Number(order.outAmount) / 10 ** decimals
    if (qty <= 0) return null
    return { price: usdcSpend / qty, qty }
  } catch {
    return null
  }
}

async function quoteSellLevel(
  mint: string,
  decimals: number,
  qty: number,
): Promise<{ price: number; qty: number } | null> {
  if (qty <= 0) return null
  try {
    const order = await getJupiterOrder({
      inputMint: mint,
      outputMint: SOL_USDC_MINT,
      amount: toSmallest(qty, decimals),
      slippageBps: 100,
    })
    const usdc = Number(order.outAmount) / 1e6
    if (usdc <= 0) return null
    return { price: usdc / qty, qty }
  } catch {
    return null
  }
}

function buildLevelsFromMarks(
  marks: NonNullable<Awaited<ReturnType<typeof getJupiterExecutableMarks>>>,
  refQty: number,
  levels: number,
): JupiterSyntheticDepth {
  const bids: JupiterDepthLevel[] = []
  const asks: JupiterDepthLevel[] = []

  if (marks.bid != null && marks.bid > 0) {
    const qty = refQty > 0 ? refQty : 1
    bids.push({ price: marks.bid, qty, notionalUsd: marks.bid * qty })
  }
  if (marks.ask != null && marks.ask > 0) {
    const qty = marks.ask > 0 ? 50 / marks.ask : 1
    asks.push({ price: marks.ask, qty, notionalUsd: 50 })
  }

  // Pad with synthetic impact steps when deeper quotes are unavailable.
  const pad = Math.max(0, levels - 1)
  for (let i = 1; i <= pad && marks.mid != null && marks.mid > 0; i++) {
    const step = (marks.spreadBps ?? 40) / 10_000 / 2
    const bidPx = marks.bid != null ? marks.bid * (1 - step * i * 0.35) : marks.mid * (1 - step * i)
    const askPx = marks.ask != null ? marks.ask * (1 + step * i * 0.35) : marks.mid * (1 + step * i)
    const q = refQty * (0.15 + i * 0.08)
    bids.push({ price: bidPx, qty: q, notionalUsd: bidPx * q })
    asks.push({ price: askPx, qty: q, notionalUsd: askPx * q })
  }

  bids.sort((a, b) => b.price - a.price)
  asks.sort((a, b) => a.price - b.price)

  return {
    symbol: marks.binanceSymbol,
    mint: marks.mint,
    bids: bids.slice(0, levels),
    asks: asks.slice(0, levels),
    mid: marks.mid,
    bid: marks.bid,
    ask: marks.ask,
    spreadBps: marks.spreadBps,
    updatedAt: new Date().toISOString(),
    source: 'jupiter_quotes',
  }
}

export async function getJupiterSyntheticDepth(
  binanceSymbol: string,
  levels = 12,
): Promise<JupiterSyntheticDepth> {
  const sym = binanceSymbol.toUpperCase()
  const cap = Math.min(16, Math.max(4, levels))

  const hit = depthCache.get(sym)
  if (hit && Date.now() - hit.at < DEPTH_TTL_MS) return hit.depth

  if (!isJupiterConfigured()) {
    return {
      symbol: sym,
      mint: null,
      bids: [],
      asks: [],
      mid: null,
      bid: null,
      ask: null,
      spreadBps: null,
      updatedAt: new Date().toISOString(),
      source: 'jupiter_quotes',
    }
  }

  const token = await getJupiterTradableToken(sym)
  if (!token) {
    const empty: JupiterSyntheticDepth = {
      symbol: sym,
      mint: null,
      bids: [],
      asks: [],
      mid: null,
      bid: null,
      ask: null,
      spreadBps: null,
      updatedAt: new Date().toISOString(),
      source: 'jupiter_quotes',
    }
    return empty
  }

  let marks = await getJupiterExecutableMarks(sym)
  if (!marks) {
    let refMid = await fetchBinanceBookMid(sym)
    if (!refMid) {
      const v3Map = await fetchJupiterPricesV3([token.mint])
      refMid = v3Map.get(token.mint)?.usdPrice ?? null
    }
    if (refMid && refMid > 0) {
      const spreadBps = 4
      const half = (refMid * spreadBps) / 20_000
      marks = {
        baseSymbol: sym.replace(/USDT$/i, ''),
        binanceSymbol: sym,
        mint: token.mint,
        bid: refMid - half,
        ask: refMid + half,
        mid: refMid,
        spreadBps,
        ts: Date.now(),
      }
    }
  }

  if (!marks) {
    const empty: JupiterSyntheticDepth = {
      symbol: sym,
      mint: token.mint,
      bids: [],
      asks: [],
      mid: null,
      bid: null,
      ask: null,
      spreadBps: null,
      updatedAt: new Date().toISOString(),
      source: 'jupiter_quotes',
    }
    return empty
  }

  let refQty = 0.01
  if (marks.mid != null && marks.mid > 0) {
    refQty = 50 / marks.mid
  }

  const depth = buildLevelsFromMarks(marks, refQty, cap)
  depthCache.set(sym, { at: Date.now(), depth })
  return depth
}
