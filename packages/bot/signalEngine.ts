/**
 * AI-assisted signal engine (RSI + EMA trend + ATR vol + volume ratio).
 * Output: BUY | SELL | HOLD with confidence 0–1.
 */

function sma(values: number[], period: number): number[] {
  return values.map((_, i) => {
    if (i < period - 1) return NaN
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += values[j]
    return sum / period
  })
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const result: number[] = []
  let prev = NaN
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(NaN)
      continue
    }
    if (i === period - 1) {
      let sum = 0
      for (let j = 0; j < period; j++) sum += values[j]
      prev = sum / period
      result.push(prev)
      continue
    }
    prev = values[i] * k + prev * (1 - k)
    result.push(prev)
  }
  return result
}

function rsi(closes: number[], period = 14): number[] {
  const result: number[] = new Array(closes.length).fill(NaN)
  if (closes.length < period + 1) return result

  let gains = 0
  let losses = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff >= 0) gains += diff
    else losses -= diff
  }
  let avgGain = gains / period
  let avgLoss = losses / period

  const rs0 = avgLoss === 0 ? Infinity : avgGain / avgLoss
  result[period] = 100 - 100 / (1 + rs0)

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    const g = diff > 0 ? diff : 0
    const l = diff < 0 ? -diff : 0
    avgGain = (avgGain * (period - 1) + g) / period
    avgLoss = (avgLoss * (period - 1) + l) / period
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss
    result[i] = 100 - 100 / (1 + rs)
  }
  return result
}

function atr(high: number[], low: number[], close: number[], period = 14): number[] {
  const result: number[] = new Array(close.length).fill(NaN)
  if (close.length < 2) return result

  const trueRanges: number[] = [NaN]
  for (let i = 1; i < close.length; i++) {
    const tr = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1])
    )
    trueRanges.push(tr)
  }

  let sum = 0
  for (let i = 1; i <= period; i++) sum += trueRanges[i]
  let prev = sum / period
  result[period] = prev

  for (let i = period + 1; i < close.length; i++) {
    prev = (prev * (period - 1) + trueRanges[i]) / period
    result[i] = prev
  }
  return result
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

export type SignalAction = 'BUY' | 'SELL' | 'HOLD'

export interface AISignalResult {
  action: SignalAction
  confidence: number
  /** Floor used for this bar — scales with volatility (lower in calm tape, higher when choppy). */
  minConfidenceRequired: number
  features: {
    rsi: number | null
    trend: 'UP' | 'DOWN' | 'FLAT'
    volatilityPct: number | null
    volumeRatio: number | null
  }
}

/** Never go below this when deciding BUY vs SELL (risk layer may still enforce a higher floor). */
export const ABSOLUTE_SIGNAL_FLOOR = 0.05

/**
 * Dynamic confidence bar + separation margin from ATR/volume context.
 * Keeps thresholds low by default and tightens automatically in volatile conditions.
 */
function dynamicThresholds(volatilityPct: number | null, volumeRatio: number | null): {
  minConfidence: number
  margin: number
} {
  const chop =
    volatilityPct === null ? 0.45 : clamp01(Math.min(volatilityPct / 14, 1))
  const flow =
    volumeRatio === null ? 0.5 : clamp01(Math.min(Math.max(volumeRatio, 0.4), 2.2) / 2.2)
  const minConfidence = clamp(0.08 + chop * 0.08 - flow * 0.04, ABSOLUTE_SIGNAL_FLOOR, 0.20)
  const margin = clamp(0.005 + chop * 0.01 - flow * 0.003, 0.003, 0.02)
  return { minConfidence, margin }
}

type KlineRow = { open: number; high: number; low: number; close: number; volume: number }

export async function fetchBinanceKlines(
  symbol: string,
  interval: '5m' | '15m' | '1h' = '15m',
  limit = 120
): Promise<KlineRow[] | null> {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`
    const res = await fetch(url)
    if (!res.ok) return null
    const raw = (await res.json()) as unknown[]
    if (!Array.isArray(raw)) return null
    return raw.map((row) => {
      const r = row as [number, string, string, string, string, string]
      return {
        open: parseFloat(r[1]),
        high: parseFloat(r[2]),
        low: parseFloat(r[3]),
        close: parseFloat(r[4]),
        volume: parseFloat(r[5]),
      }
    })
  } catch {
    return null
  }
}

export function scoreSignalFromKlines(klines: KlineRow[]): AISignalResult | null {
  if (klines.length < 52) return null

  const closes = klines.map((k) => k.close)
  const highs = klines.map((k) => k.high)
  const lows = klines.map((k) => k.low)
  const volumes = klines.map((k) => k.volume)

  const rsiSeries = rsi(closes, 14)
  const rsiLast = rsiSeries[rsiSeries.length - 1]
  if (rsiLast === undefined || Number.isNaN(rsiLast)) return null

  const ema20 = ema(closes, 20)
  const ema50 = ema(closes, 50)
  const e20 = ema20[ema20.length - 1]
  const e50 = ema50[ema50.length - 1]
  const lastClose = closes[closes.length - 1]

  let trend: 'UP' | 'DOWN' | 'FLAT' = 'FLAT'
  if (!Number.isNaN(e20) && !Number.isNaN(e50)) {
    if (e20 > e50 * 1.002 && lastClose >= e20) trend = 'UP'
    else if (e20 < e50 * 0.998 && lastClose <= e20) trend = 'DOWN'
  }

  const atrSeries = atr(highs, lows, closes, 14)
  const atrLast = atrSeries[atrSeries.length - 1]
  const volatilityPct =
    !Number.isNaN(atrLast) && lastClose > 0 ? (atrLast / lastClose) * 100 : null

  const volMa = sma(volumes, 20)
  const volAvg = volMa[volMa.length - 1]
  const lastVol = volumes[volumes.length - 1]
  const volumeRatio =
    !Number.isNaN(volAvg) && volAvg > 0 ? lastVol / volAvg : null

  const rsiBuy =
    rsiLast <= 35
      ? clamp01((50 - rsiLast) / 50) * 0.85
      : rsiLast <= 55
        ? clamp01((60 - rsiLast) / 25)
        : rsiLast < 70
          ? clamp01((70 - rsiLast) / 20) * 0.5
          : 0

  const rsiSell =
    rsiLast >= 65
      ? clamp01((rsiLast - 55) / 45)
      : rsiLast >= 45
        ? clamp01((rsiLast - 40) / 30) * 0.7
        : rsiLast < 35
          ? clamp01((45 - rsiLast) / 45) * 0.4
          : clamp01((50 - rsiLast) / 50) * 0.3

  const trendBuy = trend === 'UP' ? 0.85 : trend === 'FLAT' ? 0.45 : 0.15
  const trendSell = trend === 'DOWN' ? 0.85 : trend === 'FLAT' ? 0.45 : 0.15

  const volScore =
    volumeRatio === null ? 0.5 : clamp01(Math.min(volumeRatio, 2.5) / 2.5)

  const volNorm =
    volatilityPct === null ? 0.5 : clamp01(1 - Math.min(volatilityPct / 15, 1)) * 0.4 + 0.3

  const buyScore = clamp01(rsiBuy * 0.38 + trendBuy * 0.32 + volScore * 0.18 + volNorm * 0.12)
  const sellScore = clamp01(rsiSell * 0.38 + trendSell * 0.32 + volScore * 0.18 + volNorm * 0.12)

  const { minConfidence: MIN_CONFIDENCE, margin: MARGIN } = dynamicThresholds(volatilityPct, volumeRatio)

  let action: SignalAction
  let confidence: number
  if (buyScore >= MIN_CONFIDENCE && buyScore >= sellScore + MARGIN) {
    action = 'BUY'
    confidence = buyScore
  } else if (sellScore >= MIN_CONFIDENCE && sellScore >= buyScore + MARGIN) {
    action = 'SELL'
    confidence = sellScore
  } else {
    action = 'HOLD'
    confidence = Math.max(buyScore, sellScore)
  }

  return {
    action,
    confidence,
    minConfidenceRequired: MIN_CONFIDENCE,
    features: {
      rsi: rsiLast,
      trend,
      volatilityPct,
      volumeRatio,
    },
  }
}

export async function computeAISignal(symbol: string): Promise<AISignalResult | null> {
  const klines = await fetchBinanceKlines(symbol, '15m', 120)
  if (!klines || klines.length < 52) return null
  return scoreSignalFromKlines(klines)
}
