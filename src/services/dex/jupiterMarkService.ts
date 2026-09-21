/**
 * Unified Jupiter executable marks — bid / ask / mid from the same quote refresh.
 * Chart, order book, open positions, and live ticks read Jupiter bid/ask/mid only.
 */
import { SOL_USDC_MINT } from '../../lib/solDexCatalog'
import { getJupiterOrder, isJupiterConfigured, isJupiterSwapRateLimited } from './jupiterClassicService'
import { getJupiterTradableToken } from './jupiterTradableRegistry'
import { fetchJupiterPricesV3 } from './jupiterPriceService'

export type JupiterExecutableMarks = {
  baseSymbol: string
  binanceSymbol: string
  mint: string
  /** USDC per token when selling (executable bid). */
  bid: number | null
  /** USDC per token when buying (executable ask). */
  ask: number | null
  /** (bid + ask) / 2 — single live reference for chart + positions display. */
  mid: number | null
  spreadBps: number | null
  ts: number
}

const marksCache = new Map<string, { marks: JupiterExecutableMarks; ts: number }>()
/** Fresh enough for chart/order book without hammering Jupiter /order. */
const MARKS_TTL_MS = 4_000
/** During rate limits, serve marks up to this age rather than failing the UI. */
const MARKS_STALE_MS = 60_000

const binanceBookCache = new Map<string, { mid: number; ts: number }>()
const BINANCE_BOOK_TTL_MS = 800

const BINANCE_ENDPOINTS = [
  'https://data-api.binance.vision',
  'https://api3.binance.com',
  'https://api1.binance.com',
  'https://api.binance.com',
]

/** Fast CEX reference for majors (WBTC tracks BTCUSDT on Binance). */
export async function fetchBinanceBookMid(binanceSymbol: string): Promise<number | null> {
  const sym = binanceSymbol.toUpperCase()
  const hit = binanceBookCache.get(sym)
  if (hit && Date.now() - hit.ts < BINANCE_BOOK_TTL_MS) return hit.mid

  for (const base of BINANCE_ENDPOINTS) {
    try {
      const r = await fetch(`${base}/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(sym)}`, {
        signal: AbortSignal.timeout(3000),
      })
      if (!r.ok) continue
      const b = (await r.json()) as { bidPrice?: string; askPrice?: string }
      const bid = parseFloat(String(b.bidPrice ?? ''))
      const ask = parseFloat(String(b.askPrice ?? ''))
      if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
        const mid = (bid + ask) / 2
        binanceBookCache.set(sym, { mid, ts: Date.now() })
        return mid
      }
    } catch {
      // try next endpoint
    }
  }
  return hit?.mid ?? null
}

const DEFAULT_BUY_USD = 50
const DEFAULT_SELL_USD = 25

function toSmallest(amountHuman: number, decimals: number): string {
  const factor = 10 ** decimals
  const raw = Math.floor(amountHuman * factor)
  return String(Math.max(1, raw))
}

async function jupiterV3Usd(mint: string): Promise<number | null> {
  try {
    const prices = await fetchJupiterPricesV3([mint])
    const p = prices.get(mint)?.usdPrice
    return p != null && Number.isFinite(p) && p > 0 ? p : null
  } catch {
    return null
  }
}

async function estimateSellQty(
  token: { mint: string; decimals: number },
  positionQty?: number,
  sellUsd = DEFAULT_SELL_USD,
): Promise<number> {
  if (positionQty != null && positionQty > 0) {
    const minUsd = 8
    const v3 = await jupiterV3Usd(token.mint)
    const minQty = v3 != null && v3 > 0 ? minUsd / v3 : positionQty * 0.1
    return Math.min(positionQty, Math.max(minQty, positionQty * 0.5))
  }
  const v3 = await jupiterV3Usd(token.mint)
  if (v3 != null && v3 > 0) return sellUsd / v3
  return 0.001
}

async function quoteBuyAsk(
  token: { mint: string; decimals: number },
  usdcHuman: number,
): Promise<number | null> {
  if (usdcHuman <= 0) return null
  try {
    const order = await getJupiterOrder({
      inputMint: SOL_USDC_MINT,
      outputMint: token.mint,
      amount: toSmallest(usdcHuman, 6),
      slippageBps: 100,
    })
    const out = Number(order.outAmount) / 10 ** token.decimals
    return out > 0 ? usdcHuman / out : null
  } catch {
    return null
  }
}

async function quoteSellBid(
  token: { mint: string; decimals: number },
  sellQty: number,
): Promise<number | null> {
  if (sellQty <= 0) return null
  try {
    const order = await getJupiterOrder({
      inputMint: token.mint,
      outputMint: SOL_USDC_MINT,
      amount: toSmallest(sellQty, token.decimals),
      slippageBps: 100,
    })
    const usdcOut = Number(order.outAmount) / 1e6
    return sellQty > 0 ? usdcOut / sellQty : null
  } catch {
    return null
  }
}

export async function getJupiterExecutableMarks(
  baseOrBinanceSymbol: string,
  opts?: { buyUsd?: number; positionQty?: number; sellUsd?: number; cacheOnly?: boolean },
): Promise<JupiterExecutableMarks | null> {
  if (!isJupiterConfigured()) return null

  const raw = baseOrBinanceSymbol.toUpperCase()
  const binanceSym = raw.endsWith('USDT') ? raw : `${raw}USDT`
  const baseSymbol = binanceSym.replace(/USDT$/i, '')

  const cached = marksCache.get(binanceSym)
  if (cached && Date.now() - cached.ts < MARKS_TTL_MS) return cached.marks
  if (opts?.cacheOnly && cached && Date.now() - cached.ts < MARKS_STALE_MS) return cached.marks
  if (cached && Date.now() - cached.ts < MARKS_STALE_MS && isJupiterSwapRateLimited()) {
    return cached.marks
  }

  const token = await getJupiterTradableToken(binanceSym)
  if (!token) return null

  const buyUsd = opts?.buyUsd ?? DEFAULT_BUY_USD
  const sellQty = await estimateSellQty(token, opts?.positionQty, opts?.sellUsd ?? DEFAULT_SELL_USD)

  // Sequential probes — parallel /order calls were tripping Jupiter 429 under load.
  const ask = await quoteBuyAsk(token, buyUsd)
  const bid = await quoteSellBid(token, sellQty)

  let askFinal = ask
  let bidFinal = bid
  if (askFinal == null || bidFinal == null) {
    const v3 = await jupiterV3Usd(token.mint)
    if (v3 != null) {
      if (askFinal == null) askFinal = v3
      if (bidFinal == null) bidFinal = v3
    }
  }

  const mid =
    bidFinal != null && askFinal != null && bidFinal > 0 && askFinal > 0
      ? (bidFinal + askFinal) / 2
      : bidFinal ?? askFinal ?? null

  const spreadBps =
    bidFinal != null && askFinal != null && askFinal > 0
      ? Math.round(((askFinal - bidFinal) / askFinal) * 10_000)
      : null

  const marks: JupiterExecutableMarks = {
    baseSymbol,
    binanceSymbol: binanceSym,
    mint: token.mint,
    bid: bidFinal,
    ask: askFinal,
    mid,
    spreadBps,
    ts: Date.now(),
  }

  marksCache.set(binanceSym, { marks, ts: Date.now() })
  return marks
}

/** Estimated USDC received per 1 base token if sold now via Jupiter (bid). */
export async function quoteJupiterSellUsdPerToken(
  baseSymbol: string,
  positionQty: number,
): Promise<number | null> {
  const marks = await getJupiterExecutableMarks(baseSymbol, {
    positionQty,
    cacheOnly: isJupiterSwapRateLimited(),
  })
  return marks?.bid ?? null
}

/** Estimated USDC paid per 1 base token when buying via Jupiter (ask). */
export async function quoteJupiterBuyUsdPerToken(
  baseSymbol: string,
  buyUsd = DEFAULT_BUY_USD,
): Promise<number | null> {
  const marks = await getJupiterExecutableMarks(baseSymbol, { buyUsd })
  return marks?.ask ?? null
}
