import type { ExecutorConfig } from './config'
import type { ParsedSymbolRules } from './symbolInfo'
import { notionalForQuantity } from './sizing'

export type SafetyResult =
  | { ok: true; notionalUsd: number; feeUsd: number; requiredQuote: number }
  | { ok: false; reason: string }

/**
 * Pre-trade safety: min notional, fee cap (reject if effective fee rate > 2%), balance.
 */
export function evaluateMarketBuySafety(params: {
  cfg: ExecutorConfig
  rules: ParsedSymbolRules
  quantityStr: string
  refPrice: number
  usdtFree: number
}): SafetyResult {
  const { cfg, rules, quantityStr, refPrice, usdtFree } = params
  const notionalUsd = notionalForQuantity(quantityStr, refPrice)
  if (rules.minNotional > 0 && notionalUsd < rules.minNotional - 1e-8) {
    return {
      ok: false,
      reason: `NOTIONAL_BELOW_MIN: ${notionalUsd.toFixed(8)} < minNotional ${rules.minNotional}`,
    }
  }
  const feeRate = cfg.estimatedTakerFeeBps / 10_000
  const feeUsd = notionalUsd * feeRate
  const maxFeeAllowed = 0.02 * notionalUsd
  if (feeUsd > maxFeeAllowed + 1e-10) {
    return {
      ok: false,
      reason: `FEE_TOO_HIGH: estimated ${feeUsd.toFixed(8)} > 2% of trade (${maxFeeAllowed.toFixed(8)})`,
    }
  }
  const requiredQuote = notionalUsd + feeUsd
  if (usdtFree < requiredQuote - 1e-8) {
    return {
      ok: false,
      reason: `INSUFFICIENT_BALANCE: need ~${requiredQuote.toFixed(4)} USDT (incl. est. fee), have ${usdtFree.toFixed(4)}`,
    }
  }
  return { ok: true, notionalUsd, feeUsd, requiredQuote }
}
