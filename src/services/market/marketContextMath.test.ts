import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLongHorizon, readTimeframe, classifyRegime, type AnalysisCandle } from './marketContextMath'
import { BinanceRestLimiter, klineRequestWeight } from './binanceRestLimiter'

function candles(closes: number[]): AnalysisCandle[] {
  return closes.map((close, i) => ({
    openTime: new Date(Date.UTC(2025, 0, 1) + i * 86_400_000),
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1_000,
    quoteVolume: 1_000 * close,
    trades: 100,
  }))
}

/** Straight line from `from` to `to` across `n` bars. */
function ramp(from: number, to: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1))
}

test('long horizon needs a meaningful amount of daily history', () => {
  assert.equal(buildLongHorizon(candles(ramp(100, 110, 20))), null)
})

test('a year-long uptrend reads as bull near the 52w high', () => {
  const lh = buildLongHorizon(candles(ramp(100, 300, 365)))
  assert.ok(lh)
  assert.equal(lh.trend, 'bull')
  assert.ok(lh.rangePosition > 0.9, `rangePosition ${lh.rangePosition}`)
  assert.ok(lh.pctFromHigh52w > -3, `pctFromHigh52w ${lh.pctFromHigh52w}`)
})

test('a year-long downtrend reads as bear near the 52w low', () => {
  const lh = buildLongHorizon(candles(ramp(300, 100, 365)))
  assert.ok(lh)
  assert.equal(lh.trend, 'bear')
  assert.ok(lh.rangePosition < 0.2, `rangePosition ${lh.rangePosition}`)
  assert.ok(lh.pctFromHigh52w < -50)
})

test('max drawdown captures the worst peak-to-trough inside the window', () => {
  // 100 → 200 → 100 → 150, so the worst drawdown is 50%.
  const lh = buildLongHorizon(
    candles([...ramp(100, 200, 150), ...ramp(200, 100, 100), ...ramp(100, 150, 115)]),
  )
  assert.ok(lh)
  assert.ok(lh.maxDrawdown1yPct! > 45 && lh.maxDrawdown1yPct! < 55, `drawdown ${lh.maxDrawdown1yPct}`)
})

test('golden cross is reported when the 50d sits above the 200d', () => {
  const lh = buildLongHorizon(candles(ramp(100, 400, 365)))
  assert.ok(lh)
  assert.equal(lh.goldenCross, true)
  assert.ok(lh.sma50! > lh.sma200!)
})

test('30-day return is measured against the bar 30 days back', () => {
  const closes = ramp(100, 200, 365)
  const lh = buildLongHorizon(candles(closes))
  const expected = ((closes[364]! - closes[334]!) / closes[334]!) * 100
  assert.ok(Math.abs(lh!.return30dPct! - expected) < 1e-9)
})

test('a one-year return needs more than a year of bars', () => {
  assert.equal(buildLongHorizon(candles(ramp(100, 200, 365)))!.return365dPct, null)
  assert.notEqual(buildLongHorizon(candles(ramp(100, 200, 400)))!.return365dPct, null)
})

test('timeframe read marks a clean uptrend bullish', () => {
  const tf = readTimeframe('1h', candles(ramp(100, 200, 120)))
  assert.equal(tf.bias, 'up')
  assert.ok(tf.rsi14! > 60, `rsi ${tf.rsi14}`)
  assert.ok(tf.changePct! > 0)
})

test('timeframe read marks a clean downtrend bearish', () => {
  const tf = readTimeframe('1h', candles(ramp(200, 100, 120)))
  assert.equal(tf.bias, 'down')
  assert.ok(tf.rsi14! < 40, `rsi ${tf.rsi14}`)
})

test('timeframe read leaves indicators null when bars are too few', () => {
  const tf = readTimeframe('15m', candles(ramp(100, 101, 16)))
  assert.equal(tf.ema50, null)
  assert.equal(tf.adx, null)
  assert.equal(tf.bars, 16)
})

test('regime is unknown with no timeframes and volatile above the vol ceiling', () => {
  assert.equal(classifyRegime(null, [], 0), 'unknown')
  const lh = buildLongHorizon(candles(ramp(100, 300, 365)))!
  const tf = readTimeframe('1h', candles(ramp(100, 200, 120)))
  assert.equal(classifyRegime({ ...lh, annualizedVolPct: 200 }, [tf], 1), 'high_volatility')
})

test('kline request weight scales with page size', () => {
  assert.equal(klineRequestWeight(1), 2)
  assert.equal(klineRequestWeight(500), 4)
  assert.equal(klineRequestWeight(1000), 6)
  assert.equal(klineRequestWeight(1500), 10)
})

test('rest limiter admits calls up to the minute budget', async () => {
  const limiter = new BinanceRestLimiter(120)
  for (let i = 0; i < 20; i += 1) await limiter.acquire(6)
  assert.equal(limiter.snapshot().usedWeight, 120)
})

test('rest limiter never deadlocks on a call heavier than the whole budget', async () => {
  const limiter = new BinanceRestLimiter(60)
  await limiter.acquire(10_000)
  assert.equal(limiter.snapshot().usedWeight, 60)
})
