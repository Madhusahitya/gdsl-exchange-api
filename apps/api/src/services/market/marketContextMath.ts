/**
 * Pure analysis behind the multi-timeframe market context.
 *
 * Kept free of database and network imports so the maths can be exercised
 * directly in tests; `marketContextService` supplies the candles.
 */
import { adx, ema, last, rsi, macd, sma } from './indicators'

export type MarketInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'

export type AnalysisCandle = {
  openTime: Date
  open: number
  high: number
  low: number
  close: number
  volume: number
  quoteVolume: number
  trades: number
}

export type TimeframeRead = {
  interval: MarketInterval
  bars: number
  close: number | null
  ema20: number | null
  ema50: number | null
  rsi14: number | null
  macdHist: number | null
  adx: number | null
  changePct: number | null
  bias: 'up' | 'down' | 'flat'
}

export type LongHorizon = {
  bars: number
  coveredDays: number
  high52w: number
  low52w: number
  pctFromHigh52w: number
  pctFromLow52w: number
  /** 0 = at the 52w low, 1 = at the 52w high. */
  rangePosition: number
  return30dPct: number | null
  return90dPct: number | null
  return365dPct: number | null
  sma50: number | null
  sma200: number | null
  goldenCross: boolean | null
  annualizedVolPct: number | null
  maxDrawdown1yPct: number | null
  trend: 'bull' | 'bear' | 'range'
}

export type MarketRegime = 'trending_up' | 'trending_down' | 'choppy' | 'high_volatility' | 'unknown'

function finite(n: number): number | null {
  return Number.isFinite(n) ? n : null
}

function pctChange(from: number | undefined, to: number | undefined): number | null {
  if (from == null || to == null || from <= 0) return null
  return ((to - from) / from) * 100
}

export function readTimeframe(interval: MarketInterval, candles: AnalysisCandle[]): TimeframeRead {
  const closes = candles.map((c) => c.close)
  const highs = candles.map((c) => c.high)
  const lows = candles.map((c) => c.low)

  const close = closes[closes.length - 1] ?? null
  const ema20 = closes.length >= 20 ? finite(last(ema(closes, 20))) : null
  const ema50 = closes.length >= 50 ? finite(last(ema(closes, 50))) : null
  const rsi14 = closes.length >= 15 ? finite(last(rsi(closes, 14))) : null
  const macdHist = closes.length >= 35 ? finite(last(macd(closes).hist)) : null
  const adxVal = closes.length >= 30 ? finite(last(adx(highs, lows, closes, 14).adx)) : null

  const lookback = Math.min(24, closes.length - 1)
  const changePct = lookback > 0 ? pctChange(closes[closes.length - 1 - lookback], close ?? undefined) : null

  let bias: TimeframeRead['bias'] = 'flat'
  if (close != null && ema20 != null && ema50 != null) {
    if (close > ema20 && ema20 > ema50) bias = 'up'
    else if (close < ema20 && ema20 < ema50) bias = 'down'
  } else if (changePct != null) {
    if (changePct > 1) bias = 'up'
    else if (changePct < -1) bias = 'down'
  }

  return { interval, bars: candles.length, close, ema20, ema50, rsi14, macdHist, adx: adxVal, changePct, bias }
}

export function buildLongHorizon(daily: AnalysisCandle[]): LongHorizon | null {
  if (daily.length < 30) return null

  const window = daily.slice(-365)
  const closes = window.map((c) => c.close)
  const spot = closes[closes.length - 1]!

  const high52w = Math.max(...window.map((c) => c.high))
  const low52w = Math.min(...window.map((c) => c.low))
  const span = high52w - low52w

  const allCloses = daily.map((c) => c.close)
  const sma50 = daily.length >= 50 ? finite(last(sma(allCloses, 50))) : null
  const sma200 = daily.length >= 200 ? finite(last(sma(allCloses, 200))) : null

  // Annualised volatility from daily log returns.
  let annualizedVolPct: number | null = null
  if (window.length >= 30) {
    const rets: number[] = []
    for (let i = 1; i < window.length; i += 1) {
      const prev = closes[i - 1]!
      if (prev > 0) rets.push(Math.log(closes[i]! / prev))
    }
    if (rets.length >= 20) {
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length
      const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1)
      annualizedVolPct = Math.sqrt(variance) * Math.sqrt(365) * 100
    }
  }

  let peak = closes[0]!
  let maxDrawdown1yPct = 0
  for (const c of closes) {
    if (c > peak) peak = c
    if (peak > 0) {
      const dd = ((peak - c) / peak) * 100
      if (dd > maxDrawdown1yPct) maxDrawdown1yPct = dd
    }
  }

  const rangePosition = span > 0 ? (spot - low52w) / span : 0.5
  const aboveSma200 = sma200 != null ? spot > sma200 : null
  const goldenCross = sma50 != null && sma200 != null ? sma50 > sma200 : null

  let trend: LongHorizon['trend'] = 'range'
  if (aboveSma200 === true && goldenCross !== false && rangePosition > 0.5) trend = 'bull'
  else if (aboveSma200 === false && goldenCross !== true && rangePosition < 0.4) trend = 'bear'

  return {
    bars: daily.length,
    coveredDays: window.length,
    high52w,
    low52w,
    pctFromHigh52w: high52w > 0 ? ((spot - high52w) / high52w) * 100 : 0,
    pctFromLow52w: low52w > 0 ? ((spot - low52w) / low52w) * 100 : 0,
    rangePosition: Math.min(1, Math.max(0, rangePosition)),
    return30dPct: pctChange(allCloses[allCloses.length - 31], spot),
    return90dPct: pctChange(allCloses[allCloses.length - 91], spot),
    return365dPct: pctChange(allCloses[allCloses.length - 366], spot),
    sma50,
    sma200,
    goldenCross,
    annualizedVolPct,
    maxDrawdown1yPct,
    trend,
  }
}

export function classifyRegime(
  longHorizon: LongHorizon | null,
  timeframes: TimeframeRead[],
  alignmentScore: number,
): MarketRegime {
  if (timeframes.length === 0) return 'unknown'
  if (longHorizon?.annualizedVolPct != null && longHorizon.annualizedVolPct > 120) return 'high_volatility'

  const strengths = timeframes.map((t) => t.adx).filter((a): a is number => a != null)
  const avgAdx = strengths.length > 0 ? strengths.reduce((a, b) => a + b, 0) / strengths.length : null

  if (avgAdx != null && avgAdx < 20) return 'choppy'
  if (alignmentScore >= 0.4) return 'trending_up'
  if (alignmentScore <= -0.4) return 'trending_down'
  return 'choppy'
}
