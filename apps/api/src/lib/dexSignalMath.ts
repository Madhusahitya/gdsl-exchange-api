/**
 * Mirrors `apps/web/src/lib/dex/strategy.ts` for server-side token alerts.
 * Indicative only — Binance spot closes as a proxy; not investment advice.
 */

export type DexSignal = 'BUY' | 'SELL' | 'HOLD'

export function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null
  const slice = closes.slice(-period)
  return slice.reduce((a, b) => a + b, 0) / period
}

export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null
  let gains = 0
  let losses = 0
  for (let i = closes.length - period; i < closes.length; i++) {
    const delta = closes[i]! - closes[i - 1]!
    if (delta >= 0) gains += delta
    else losses -= delta
  }
  const avgGain = gains / period
  const avgLoss = losses / period
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

export type SignalOptions = {
  smaPeriod: number
  threshold: number
  useRsiFilter: boolean
  rsiBuyMax: number
  rsiSellMin: number
}

export function computeTrendRsiSignal(
  closes: number[],
  opts: SignalOptions,
): { signal: DexSignal; smaValue: number | null; rsiValue: number | null } {
  const { smaPeriod, threshold, useRsiFilter, rsiBuyMax, rsiSellMin } = opts
  const rsiValue = rsi(closes, 14)
  const smaValue = sma(closes, smaPeriod)
  if (smaValue === null || closes.length === 0) {
    return { signal: 'HOLD', smaValue: null, rsiValue }
  }
  const last = closes[closes.length - 1]!
  const diff = (last - smaValue) / smaValue
  let signal: DexSignal = 'HOLD'
  if (diff > threshold) {
    if (!useRsiFilter || rsiValue === null || rsiValue < rsiBuyMax) signal = 'BUY'
    else signal = 'HOLD'
  } else if (diff < -threshold) {
    if (!useRsiFilter || rsiValue === null || rsiValue > rsiSellMin) signal = 'SELL'
    else signal = 'HOLD'
  }
  return { signal, smaValue, rsiValue }
}
