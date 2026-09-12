import type { ParsedSymbolRules } from './symbolInfo'
import { countDecimals } from './sizing'

/**
 * Parse and validate quantity string against LOT / MARKET_LOT_SIZE rules.
 * Ensures step alignment and precision matches Binance expectations.
 */
export function assertValidQuantityForSymbol(quantityStr: string, rules: ParsedSymbolRules): number {
  const s = quantityStr.trim()
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Invalid quantity format: ${quantityStr}`)
  }
  const q = parseFloat(s)
  if (!Number.isFinite(q) || q <= 0) {
    throw new Error('Quantity must be a positive finite number')
  }

  const { minQty, maxQty, stepSize } = rules.lot
  const min = parseFloat(minQty)
  const max = parseFloat(maxQty)
  const step = parseFloat(stepSize)
  if (!Number.isFinite(step) || step <= 0) {
    throw new Error('Invalid stepSize from exchange info')
  }

  if (q < min - 1e-10) {
    throw new Error(`Quantity ${s} below minQty ${minQty}`)
  }
  if (q > max + 1e-10) {
    throw new Error(`Quantity ${s} above maxQty ${maxQty}`)
  }

  const stepsInt = Math.round(q / step)
  const reconstructed = stepsInt * step
  if (Math.abs(q - reconstructed) > step * 1e-6) {
    throw new Error(`Quantity ${s} is not a valid multiple of stepSize ${stepSize}`)
  }

  const decimals = countDecimals(stepSize)
  const normalized = q.toFixed(decimals)
  if (normalized !== s) {
    throw new Error(
      `Quantity string ${s} must use ${decimals} decimal places for stepSize ${stepSize} (expected ${normalized})`
    )
  }

  return q
}

/** Quote notional for a MARKET order at reference price. */
export function assertMinNotionalMet(quantityStr: string, refPrice: number, rules: ParsedSymbolRules): void {
  if (refPrice <= 0 || !Number.isFinite(refPrice)) {
    throw new Error('refPrice must be positive for notional validation')
  }
  const n = parseFloat(quantityStr) * refPrice
  if (rules.minNotional > 0 && n < rules.minNotional - 1e-8) {
    throw new Error(
      `Notional ${n.toFixed(8)} below minNotional ${rules.minNotional} (qty ${quantityStr} @ ${refPrice})`
    )
  }
}
