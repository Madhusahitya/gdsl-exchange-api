/**
 * Paper trading models **spot market orders** (not free mid prints):
 * - Buy: pay **ask + adverse slippage**, then taker fee on quote.
 * - Sell: receive **bid − adverse slippage**, then taker fee on base proceeds.
 * Defaults match typical Binance spot VIP0-style costs (fees + a small slip budget).
 */

const DEFAULT_FEE_BPS = 10

/** Adverse selection vs touch: market buys lift through the ask; sells hit below the bid. */
const DEFAULT_ASSUMED_SLIPPAGE_BPS = 10

export function getPaperAssumedSlippageBps(): number {
  const raw = process.env.PAPER_ASSUMED_SLIPPAGE_BPS
  const n = raw ? parseInt(raw, 10) : NaN
  if (!Number.isFinite(n) || n < 0 || n > 500) return DEFAULT_ASSUMED_SLIPPAGE_BPS
  return n
}

export function getPaperTakerFeeBps(): number {
  const raw = process.env.PAPER_TAKER_FEE_BPS
  const n = raw ? parseInt(raw, 10) : NaN
  if (!Number.isFinite(n) || n < 0 || n > 200) return DEFAULT_FEE_BPS
  return n
}

function feeRate(): number {
  return getPaperTakerFeeBps() / 10000
}

function slipRate(): number {
  return getPaperAssumedSlippageBps() / 10000
}

/**
 * Effective **buy** fill (USDT per base) for a market-style lift: worse than top ask.
 */
export function paperExecutionBuyPrice(topAsk: number): number {
  return topAsk * (1 + slipRate())
}

/**
 * Effective **sell** fill (USDT per base) for a market-style hit: worse than top bid.
 */
export function paperExecutionSellPrice(topBid: number): number {
  return Math.max(1e-12, topBid * (1 - slipRate()))
}

/** Base asset qty: USDT alloc buys at ask, after taker fee on the quote spent */
export function baseQtyFromPaperBuy(allocUsd: number, ask: number): number {
  const f = feeRate()
  return (allocUsd * (1 - f)) / ask
}

/** Net USDT received selling base at bid after taker fee */
export function proceedsPaperSell(baseQty: number, bid: number): number {
  const f = feeRate()
  return baseQty * bid * (1 - f)
}

/** Closed PnL vs initial alloc (both legs pay taker fee) */
export function paperRoundTripPnl(allocUsd: number, entryAsk: number, exitBid: number): number {
  const base = baseQtyFromPaperBuy(allocUsd, entryAsk)
  const proceeds = proceedsPaperSell(base, exitBid)
  return proceeds - allocUsd
}

/**
 * Mark-to-market for an open long: hypothetical exit at **market** (bid − slip) with fees,
 * consistent with `paperClosePosition`.
 */
export function paperUnrealizedPnlUsd(allocUsd: number, entryExecutionPrice: number, topOfBookBid: number): number {
  const exitExec = paperExecutionSellPrice(topOfBookBid)
  return paperRoundTripPnl(allocUsd, entryExecutionPrice, exitExec)
}
