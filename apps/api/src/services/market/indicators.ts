/**
 * Pure technical indicator functions.
 * All functions expect arrays of numbers (most-recent value LAST).
 * Return NaN for positions where there isn't enough data yet.
 */

/** Simple Moving Average */
export function sma(values: number[], period: number): number[] {
  return values.map((_, i) => {
    if (i < period - 1) return NaN
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += values[j]
    return sum / period
  })
}

/** Exponential Moving Average */
export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const result: number[] = []
  let prev = NaN
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(NaN)
      continue
    }
    if (i === period - 1) {
      // seed with SMA
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

/** Relative Strength Index */
export function rsi(closes: number[], period = 14): number[] {
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

/** MACD — returns { macd, signal, hist } arrays */
export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9
): { macd: number[]; signal: number[]; hist: number[] } {
  const emaFast = ema(closes, fast)
  const emaSlow = ema(closes, slow)
  const macdLine = emaFast.map((v, i) =>
    isNaN(v) || isNaN(emaSlow[i]) ? NaN : v - emaSlow[i]
  )

  // Signal = EMA(macdLine, signalPeriod) — only on valid macdLine values
  const validStart = closes.findIndex((_, i) => !isNaN(macdLine[i]))
  const signalLine: number[] = new Array(closes.length).fill(NaN)
  const histLine: number[] = new Array(closes.length).fill(NaN)

  if (validStart >= 0) {
    const sub = macdLine.slice(validStart)
    const sigSub = ema(sub, signalPeriod)
    for (let i = 0; i < sigSub.length; i++) {
      const absIdx = validStart + i
      signalLine[absIdx] = sigSub[i]
      if (!isNaN(sigSub[i]) && !isNaN(macdLine[absIdx])) {
        histLine[absIdx] = macdLine[absIdx] - sigSub[i]
      }
    }
  }

  return { macd: macdLine, signal: signalLine, hist: histLine }
}

/** Bollinger Bands — returns { upper, middle, lower } */
export function bollinger(
  closes: number[],
  period = 20,
  stdDev = 2
): { upper: number[]; middle: number[]; lower: number[] } {
  const mid = sma(closes, period)
  const upper: number[] = []
  const lower: number[] = []

  for (let i = 0; i < closes.length; i++) {
    if (isNaN(mid[i])) {
      upper.push(NaN)
      lower.push(NaN)
      continue
    }
    let variance = 0
    for (let j = i - period + 1; j <= i; j++) {
      variance += Math.pow(closes[j] - mid[i], 2)
    }
    const sd = Math.sqrt(variance / period)
    upper.push(mid[i] + stdDev * sd)
    lower.push(mid[i] - stdDev * sd)
  }

  return { upper, middle: mid, lower }
}

/** Average True Range */
export function atr(
  high: number[],
  low: number[],
  close: number[],
  period = 14
): number[] {
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

  // Wilder smoothing
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

/** On-Balance Volume */
export function obv(closes: number[], volumes: number[]): number[] {
  const result: number[] = [volumes[0]]
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) result.push(result[i - 1] + volumes[i])
    else if (closes[i] < closes[i - 1]) result.push(result[i - 1] - volumes[i])
    else result.push(result[i - 1])
  }
  return result
}

/** Stochastic Oscillator — returns { k, d } */
export function stochastic(
  high: number[],
  low: number[],
  close: number[],
  kPeriod = 14,
  dPeriod = 3
): { k: number[]; d: number[] } {
  const k: number[] = new Array(close.length).fill(NaN)

  for (let i = kPeriod - 1; i < close.length; i++) {
    let highest = -Infinity
    let lowest = Infinity
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (high[j] > highest) highest = high[j]
      if (low[j] < lowest) lowest = low[j]
    }
    const range = highest - lowest
    k[i] = range === 0 ? 50 : ((close[i] - lowest) / range) * 100
  }

  const d = sma(k.map((v) => (isNaN(v) ? 0 : v)), dPeriod).map((v, i) =>
    isNaN(k[i]) ? NaN : v
  )

  return { k, d }
}

/** Linear regression slope over a window — positive = uptrend */
export function linRegSlope(values: number[], window: number): number[] {
  const result: number[] = new Array(values.length).fill(NaN)
  for (let i = window - 1; i < values.length; i++) {
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0
    for (let j = 0; j < window; j++) {
      sumX += j; sumY += values[i - window + 1 + j]
      sumXY += j * values[i - window + 1 + j]; sumX2 += j * j
    }
    const n = window
    result[i] = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX)
  }
  return result
}

/** Last valid (non-NaN) value in an array */
export function last(arr: number[]): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (!isNaN(arr[i])) return arr[i]
  }
  return NaN
}

/**
 * Average Directional Index (ADX) with +DI and -DI.
 * ADX < 20  → ranging / weak trend
 * ADX 20-25 → developing trend
 * ADX > 25  → strong trend
 */
export function adx(
  high: number[],
  low: number[],
  close: number[],
  period = 14,
): { adx: number[]; plusDI: number[]; minusDI: number[] } {
  const n = close.length
  const adxArr:    number[] = new Array(n).fill(NaN)
  const plusDIArr: number[] = new Array(n).fill(NaN)
  const minusDIArr:number[] = new Array(n).fill(NaN)

  if (n < period * 2 + 1) return { adx: adxArr, plusDI: plusDIArr, minusDI: minusDIArr }

  // True range and directional movement
  const trArr:   number[] = [NaN]
  const plusDMArr:  number[] = [NaN]
  const minusDMArr: number[] = [NaN]

  for (let i = 1; i < n; i++) {
    const upMove   = high[i]  - high[i - 1]
    const downMove = low[i - 1] - low[i]
    plusDMArr.push(upMove > downMove && upMove > 0 ? upMove : 0)
    minusDMArr.push(downMove > upMove && downMove > 0 ? downMove : 0)
    trArr.push(Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i]  - close[i - 1]),
    ))
  }

  // Wilder smooth TR, +DM, -DM
  let smoothTR   = trArr.slice(1, period + 1).reduce((a, b) => a + b, 0)
  let smoothPlus = plusDMArr.slice(1, period + 1).reduce((a, b) => a + b, 0)
  let smoothMinus= minusDMArr.slice(1, period + 1).reduce((a, b) => a + b, 0)

  const dxArr: number[] = []

  const fillDI = (i: number, sP: number, sM: number, sTR: number) => {
    const pdi = sTR === 0 ? 0 : (sP / sTR) * 100
    const mdi = sTR === 0 ? 0 : (sM / sTR) * 100
    plusDIArr[i]  = pdi
    minusDIArr[i] = mdi
    const sum = pdi + mdi
    dxArr.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100)
  }

  fillDI(period, smoothPlus, smoothMinus, smoothTR)

  for (let i = period + 1; i < n; i++) {
    smoothTR    = smoothTR    - smoothTR    / period + trArr[i]
    smoothPlus  = smoothPlus  - smoothPlus  / period + plusDMArr[i]
    smoothMinus = smoothMinus - smoothMinus / period + minusDMArr[i]
    fillDI(i, smoothPlus, smoothMinus, smoothTR)
  }

  // ADX = Wilder smooth of DX over period
  if (dxArr.length < period) return { adx: adxArr, plusDI: plusDIArr, minusDI: minusDIArr }

  let adxVal = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period
  const adxStart = period + period  // index in original array
  adxArr[adxStart] = adxVal

  for (let k = 1; k < dxArr.length - period + 1; k++) {
    adxVal = (adxVal * (period - 1) + dxArr[period - 1 + k]) / period
    adxArr[adxStart + k] = adxVal
  }

  return { adx: adxArr, plusDI: plusDIArr, minusDI: minusDIArr }
}
