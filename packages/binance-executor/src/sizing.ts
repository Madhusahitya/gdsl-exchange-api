import type { ParsedSymbolRules } from './symbolInfo'

export function countDecimals(stepSize: string): number {
  if (!stepSize.includes('.')) return 0
  return stepSize.replace(/0+$/, '').split('.')[1]?.length ?? 0
}

/**
 * Floor quantity to valid stepSize; return string per Binance quantity precision.
 */
export function adjustQuantityToLotSize(quantity: number, rules: ParsedSymbolRules): string {
  const { stepSize, minQty, maxQty } = rules.lot
  const step = parseFloat(stepSize)
  const minQ = parseFloat(minQty)
  const maxQ = parseFloat(maxQty)
  if (!Number.isFinite(step) || step <= 0) throw new Error('Invalid stepSize')
  const decimals = countDecimals(stepSize)
  let steps = Math.floor(quantity / step + 1e-12)
  let q = steps * step
  if (q < minQ - 1e-12) {
    steps = Math.ceil(minQ / step - 1e-12)
    q = steps * step
  }
  if (q > maxQ + 1e-12) {
    throw new Error(`Quantity ${q} exceeds maxQty ${maxQty}`)
  }
  if (q < minQ - 1e-12) {
    throw new Error(`Quantity ${q} below minQty ${minQty} after step rounding`)
  }
  return q.toFixed(decimals)
}

/**
 * Convert USD notional (quote, e.g. USDT) to base quantity using ref price.
 */
export function usdNotionalToBaseQuantity(usd: number, refPrice: number, rules: ParsedSymbolRules): string {
  if (usd <= 0 || !Number.isFinite(usd)) throw new Error('usd must be positive')
  if (refPrice <= 0 || !Number.isFinite(refPrice)) throw new Error('refPrice must be positive')
  const rawQty = usd / refPrice
  let qStr = adjustQuantityToLotSize(rawQty, rules)
  const minN = rules.minNotional
  if (minN <= 0) return qStr

  let n = notionalForQuantity(qStr, refPrice)
  if (n >= minN - 1e-8) return qStr

  const step = parseFloat(rules.lot.stepSize)
  const maxQ = parseFloat(rules.lot.maxQty)
  const decimals = countDecimals(rules.lot.stepSize)
  let q = parseFloat(qStr)

  while (n < minN - 1e-8) {
    q += step
    if (q > maxQ + 1e-12) {
      throw new Error(
        `Cannot satisfy minNotional ${minN} within maxQty ${rules.lot.maxQty} at price ${refPrice} (budget ~${usd} USDT)`
      )
    }
    qStr = q.toFixed(decimals)
    n = notionalForQuantity(qStr, refPrice)
  }

  return qStr
}

export function notionalForQuantity(quantityStr: string, price: number): number {
  return parseFloat(quantityStr) * price
}
