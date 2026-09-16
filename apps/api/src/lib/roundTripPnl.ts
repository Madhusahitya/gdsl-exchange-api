/**
 * Filters pre-fix trade rows where `pnl` stored sell proceeds (~full allocation)
 * instead of round-trip USDT delta. Those rows show +$4.95 on a $5 BUY with
 * exit below entry — they inflate 7-day PnL while the wallet barely moves.
 */

export type RoundTripPnlRow = {
  pnl: unknown
  allocationUsd?: unknown
  entryPrice?: unknown
  exitPrice?: unknown
  /** When set, picks BSC vs Solana gas for net PnL display. */
  strategyName?: string | null
}

/** Strategy book name for DEX Jupiter — must match DB `Strategy.name`. */
export const JUPITER_DEX_STRATEGY_NAME = 'DEX Jupiter SOL'

const MAJOR_BASES = new Set(['BTC', 'ETH', 'SOL', 'WBTC', 'WETH', 'JUP', 'BNB', 'XRP'])

function toNum(v: unknown): number {
  if (v == null) return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** True when CLOSED row looks like a trustworthy BUY→SELL round-trip PnL. */
export function isTrustworthyRoundTripPnl(row: RoundTripPnlRow): boolean {
  const pnl = toNum(row.pnl)
  const alloc = toNum(row.allocationUsd)
  const entry = toNum(row.entryPrice)
  const exit = toNum(row.exitPrice)
  if (entry <= 0 || exit <= 0) return false

  // Pre-fix: pnl ≈ USDT received on sell while price fell vs entry.
  if (alloc > 0 && pnl > 0 && pnl >= alloc * 0.85 && exit < entry * 0.9995) {
    return false
  }
  if (alloc > 0 && pnl < 0 && pnl <= -alloc * 0.85 && exit > entry * 1.0005) {
    return false
  }
  // Stored pnl sign disagrees with fill prices (e.g. +$0.16 while exit < entry).
  const fillEst = estimateRoundTripPnlFromFills(row)
  if (fillEst != null && alloc > 0) {
    if (pnl > alloc * 0.005 && fillEst < -alloc * 0.005) return false
    if (pnl < -alloc * 0.005 && fillEst > alloc * 0.005) return false
    if (Math.abs(pnl - fillEst) > Math.max(alloc * 0.08, 0.25)) return false
  }
  // BNB/WBNB bug: only part of WBNB was sold but full buy notional was booked.
  const pxMove = Math.abs(exit - entry) / entry
  const pnlFrac = Math.abs(pnl) / alloc
  if (alloc > 0 && pxMove < 0.025 && pnlFrac > 0.12) return false
  // Impossible spot round-trip gain without leverage (>120% on one hop).
  if (alloc > 0 && pnl > alloc * 1.2) return false

  return true
}

/** Estimate USDT PnL from fill prices when stored pnl is corrupt. */
export function estimateRoundTripPnlFromFills(row: RoundTripPnlRow): number | null {
  const alloc = toNum(row.allocationUsd)
  const entry = toNum(row.entryPrice)
  const exit = toNum(row.exitPrice)
  if (alloc <= 0 || entry <= 0 || exit <= 0) return null
  const est = alloc * (exit / entry - 1)
  return Number.isFinite(est) ? Math.round(est * 1e8) / 1e8 : null
}

/** Realized PnL for a closed lot from on-chain fill prices (includes LP fees in fills). */
export function roundTripRealizedPnl(buyAlloc: number, buyEntry: number, sellExit: number): number {
  if (buyAlloc <= 0 || buyEntry <= 0 || sellExit <= 0) return 0
  const raw = buyAlloc * (sellExit / buyEntry - 1)
  return Number.isFinite(raw) ? Math.round(raw * 1e8) / 1e8 : 0
}

/** Typical BSC gas for approve + buy swap + sell swap on Personal Wallet (not in fill prices). */
export const BSC_DEX_ROUND_TRIP_GAS_USD = 0.09

/** Typical Solana priority + base fee for buy + sell (~0.0002 SOL at ~$75). */
export const SOLANA_DEX_ROUND_TRIP_FEE_USD = 0.015

/**
 * Estimated wallet PnL if the sell fills at quoted price minus max slippage, then gas.
 * Used by auto-exit so TP does not fire on +1.5% quote that becomes a net loss on $5–10 lots.
 */
export function estimatedNetRoundTripUsd(
  buyAllocUsd: number,
  entryPrice: number,
  quotedExitPrice: number,
  slippageBps: number,
  gasUsd: number = BSC_DEX_ROUND_TRIP_GAS_USD,
): number {
  if (buyAllocUsd <= 0 || entryPrice <= 0 || quotedExitPrice <= 0) return -gasUsd
  const gross = buyAllocUsd * (quotedExitPrice / entryPrice - 1)
  const afterSlippage = gross * (1 - Math.min(2000, Math.max(0, slippageBps)) / 10_000)
  return Math.round((afterSlippage - gasUsd) * 1e8) / 1e8
}

/** Gross fill-based PnL minus estimated round-trip gas — matches wallet drift on small trades. */
export function netRoundTripPnlAfterGas(
  grossPnl: number | null,
  gasUsd: number = BSC_DEX_ROUND_TRIP_GAS_USD,
): number | null {
  if (grossPnl == null || !Number.isFinite(grossPnl)) return null
  return Math.round((grossPnl - gasUsd) * 1e8) / 1e8
}

/**
 * Detect rows where entry/exit prices are implausible (wrong token decimals, etc.).
 * Example: GLDX $32 buy recorded at $3,755/token instead of ~$0.40.
 */
export function isCorruptDexFillPrices(row: RoundTripPnlRow & { pair?: string | null }): boolean {
  const alloc = toNum(row.allocationUsd)
  const entry = toNum(row.entryPrice)
  const exit = toNum(row.exitPrice)
  if (alloc <= 0 || entry <= 0 || exit <= 0) return false

  const base = (row.pair ?? '').split('/')[0]?.toUpperCase() ?? ''
  if (MAJOR_BASES.has(base)) return false

  // Small alt/meme lots should never show hundreds–thousands $/token.
  if (entry > 20 && alloc < 500) return true
  if (exit > 20 && alloc < 500) return true

  const impliedQty = alloc / entry
  if (impliedQty > 0 && impliedQty < 0.02 && alloc >= 5) return true

  return false
}

/** Closed round-trips shown in trade log / investor stats (wins only, no corrupt fills). */
export function shouldIncludeClosedTradeInPublicLog(
  row: RoundTripPnlRow & { pair?: string | null; strategyName?: string | null },
): boolean {
  if (isCorruptDexFillPrices(row)) return false
  const net = displayNetRoundTripPnl(row)
  if (net == null) return false
  return net > 1e-6
}

/** PnL safe to show in trade log / dashboard stats. */
export function displayRoundTripPnl(row: RoundTripPnlRow): number | null {
  const fromFills = estimateRoundTripPnlFromFills(row)
  if (fromFills != null) return fromFills
  if (isTrustworthyRoundTripPnl(row)) return toNum(row.pnl)
  return toNum(row.pnl)
}

/** Estimated round-trip gas by strategy book (BSC DEX vs Jupiter on Solana). */
export function roundTripGasUsdForStrategy(strategyName?: string | null): number {
  if (strategyName === JUPITER_DEX_STRATEGY_NAME) return SOLANA_DEX_ROUND_TRIP_FEE_USD
  return BSC_DEX_ROUND_TRIP_GAS_USD
}

/** Net PnL for investor-facing stats (fill PnL − est. round-trip gas). */
export function displayNetRoundTripPnl(row: RoundTripPnlRow, gasUsd?: number): number | null {
  const gas = gasUsd ?? roundTripGasUsdForStrategy(row.strategyName)
  return netRoundTripPnlAfterGas(displayRoundTripPnl(row), gas)
}
