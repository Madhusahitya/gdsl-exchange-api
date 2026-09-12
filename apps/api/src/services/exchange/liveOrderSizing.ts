/**
 * Safe Binance live order sizing.
 *
 * Replaces the old "90% of free USDT" default so CEX automation can be
 * compared with Jupiter Super Machine without risking most of the account.
 *
 * Pure helpers — no I/O — so they are easy to unit-test.
 */

export type LiveOrderSizeInput = {
  /** Free USDT on the exchange. */
  freeUsdt: number
  /** UI slider 10–100 (percent of free USDT to risk per entry). */
  tradeSizePct: number
  /** Optional hard cap from the request body. */
  requestedOrderSizeUsdt?: number | null
  /** From RiskRule.maxOrderNotional when set. */
  maxOrderNotional?: number | null
  /** Operator / env hard cap (e.g. CEX_LIVE_MAX_ORDER_USDT). */
  envMaxOrderUsdt?: number | null
  /** Never leave the account empty — keep a small buffer. Default 0.95. */
  maxFreeFraction?: number
  /** Binance / validator floor. Default 5. */
  minOrderUsdt?: number
}

export type LiveOrderSizeResult = {
  orderSizeUsdt: number
  caps: {
    fromPct: number
    fromRequested: number | null
    fromRiskRule: number | null
    fromEnv: number | null
    fromFreeBuffer: number
  }
  reasons: string[]
}

function finitePositive(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}

/** Round down to 2 decimal places (USDT cents). */
export function floorUsdt(n: number): number {
  return Math.floor(n * 100) / 100
}

/**
 * Compute a conservative per-entry notional for Binance live automation.
 */
export function computeLiveOrderSize(input: LiveOrderSizeInput): LiveOrderSizeResult {
  const minOrder = finitePositive(input.minOrderUsdt) ? input.minOrderUsdt : 5
  const free = finitePositive(input.freeUsdt) ? input.freeUsdt : 0
  const pct = Math.min(100, Math.max(10, Number(input.tradeSizePct) || 50))
  const maxFreeFraction =
    finitePositive(input.maxFreeFraction) && input.maxFreeFraction <= 1
      ? input.maxFreeFraction
      : 0.95

  const fromPct = floorUsdt(free * (pct / 100))
  const fromFreeBuffer = floorUsdt(free * maxFreeFraction)
  const fromRequested = finitePositive(input.requestedOrderSizeUsdt)
    ? floorUsdt(input.requestedOrderSizeUsdt)
    : null
  const fromRiskRule = finitePositive(input.maxOrderNotional)
    ? floorUsdt(input.maxOrderNotional)
    : null
  const fromEnv = finitePositive(input.envMaxOrderUsdt) ? floorUsdt(input.envMaxOrderUsdt) : null

  let order = fromPct
  const reasons: string[] = [`${pct}% of free USDT → $${fromPct.toFixed(2)}`]

  if (fromRequested != null && fromRequested < order) {
    order = fromRequested
    reasons.push(`Requested cap → $${fromRequested.toFixed(2)}`)
  }
  if (fromRiskRule != null && fromRiskRule < order) {
    order = fromRiskRule
    reasons.push(`Risk maxOrderNotional → $${fromRiskRule.toFixed(2)}`)
  }
  if (fromEnv != null && fromEnv < order) {
    order = fromEnv
    reasons.push(`CEX env max → $${fromEnv.toFixed(2)}`)
  }
  if (fromFreeBuffer < order) {
    order = fromFreeBuffer
    reasons.push(`Free-balance buffer (${Math.round(maxFreeFraction * 100)}%) → $${fromFreeBuffer.toFixed(2)}`)
  }

  order = floorUsdt(order)

  if (order < minOrder) {
    reasons.push(`Below minimum $${minOrder.toFixed(2)} — not enough free USDT at ${pct}%`)
  }

  return {
    orderSizeUsdt: order,
    caps: {
      fromPct,
      fromRequested,
      fromRiskRule,
      fromEnv,
      fromFreeBuffer,
    },
    reasons,
  }
}
