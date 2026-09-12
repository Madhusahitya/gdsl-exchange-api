import test from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateProbability,
  expectedValuePerDollar,
  impliedProbability,
  judgeEdge,
  normalCdf,
  parseCryptoClaim,
  stakeBreakdown,
} from './predictionMath'

test('normal cdf matches known quantiles', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6)
  assert.ok(Math.abs(normalCdf(1.6449) - 0.95) < 1e-4)
  assert.ok(Math.abs(normalCdf(-1.6449) - 0.05) < 1e-4)
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-4)
})

test('parses a dollar strike with thousands separators', () => {
  const c = parseCryptoClaim('Will Bitcoin reach $100,000 by Dec 31?')
  assert.ok(c)
  assert.equal(c.base, 'BTC')
  assert.equal(c.strike, 100_000)
  assert.equal(c.direction, 'above')
  // "reach" means touching the level is enough.
  assert.equal(c.isTouch, true)
})

test('parses k and m suffixes', () => {
  assert.equal(parseCryptoClaim('BTC above $95k on Friday')!.strike, 95_000)
  assert.equal(parseCryptoClaim('Will ETH top $8K this year')!.strike, 8_000)
  assert.equal(parseCryptoClaim('Bitcoin market cap above $2.5M')!.strike, 2_500_000)
})

test('reads a downside claim as below', () => {
  const c = parseCryptoClaim('Will Solana dip below $80 in March?')
  assert.ok(c)
  assert.equal(c.base, 'SOL')
  assert.equal(c.direction, 'below')
  assert.equal(c.strike, 80)
})

test('at-expiry wording is not treated as a touch market', () => {
  const c = parseCryptoClaim('Will BTC close above $120,000 on Dec 31?')
  assert.ok(c)
  assert.equal(c.isTouch, false)
})

test('returns null when the label is not a single crypto strike', () => {
  assert.equal(parseCryptoClaim('Who wins the 2026 election?'), null)
  assert.equal(parseCryptoClaim('Will it rain tomorrow?'), null)
  // A number with no recognisable asset is not enough to act on.
  assert.equal(parseCryptoClaim('Over $100,000 raised'), null)
})

test('a far out-of-reach strike is very unlikely, a near one is not', () => {
  const far = estimateProbability({
    spot: 100,
    strike: 400,
    direction: 'above',
    days: 30,
    annualizedVolPct: 60,
    isTouch: false,
  })!
  const near = estimateProbability({
    spot: 100,
    strike: 105,
    direction: 'above',
    days: 30,
    annualizedVolPct: 60,
    isTouch: false,
  })!
  assert.ok(far < 0.01, `far ${far}`)
  assert.ok(near > 0.3 && near < 0.5, `near ${near}`)
})

test('at-the-money at-expiry probability sits just under a half', () => {
  // The -sigma^2*t/2 log drift makes the median finish slightly below spot.
  const p = estimateProbability({
    spot: 100,
    strike: 100,
    direction: 'above',
    days: 90,
    annualizedVolPct: 80,
    isTouch: false,
  })!
  assert.ok(p > 0.4 && p < 0.5, `p ${p}`)
})

test('above and below are complementary at the same strike', () => {
  const args = { spot: 100, strike: 120, days: 60, annualizedVolPct: 70, isTouch: false } as const
  const above = estimateProbability({ ...args, direction: 'above' })!
  const below = estimateProbability({ ...args, direction: 'below' })!
  assert.ok(Math.abs(above + below - 1) < 1e-9)
})

test('touching a level is likelier than finishing beyond it', () => {
  const args = {
    spot: 100,
    strike: 130,
    direction: 'above' as const,
    days: 90,
    annualizedVolPct: 70,
  }
  const atExpiry = estimateProbability({ ...args, isTouch: false })!
  const touch = estimateProbability({ ...args, isTouch: true })!
  assert.ok(touch > atExpiry, `touch ${touch} vs expiry ${atExpiry}`)
  assert.ok(touch <= 1)
})

test('a touch market already through its level is certain', () => {
  const p = estimateProbability({
    spot: 150,
    strike: 100,
    direction: 'above',
    days: 30,
    annualizedVolPct: 60,
    isTouch: true,
  })
  assert.equal(p, 1)
})

test('higher volatility raises the chance of reaching a distant strike', () => {
  const base = { spot: 100, strike: 150, direction: 'above' as const, days: 90, isTouch: false }
  const calm = estimateProbability({ ...base, annualizedVolPct: 30 })!
  const wild = estimateProbability({ ...base, annualizedVolPct: 120 })!
  assert.ok(wild > calm, `wild ${wild} calm ${calm}`)
})

test('a settled market collapses to a certainty', () => {
  const args = { strike: 100, days: 0, annualizedVolPct: 60, isTouch: false } as const
  assert.equal(estimateProbability({ ...args, spot: 120, direction: 'above' }), 1)
  assert.equal(estimateProbability({ ...args, spot: 80, direction: 'above' }), 0)
  assert.equal(estimateProbability({ ...args, spot: 80, direction: 'below' }), 1)
})

test('probability is null on unusable inputs', () => {
  const args = { strike: 100, direction: 'above' as const, days: 30, isTouch: false }
  assert.equal(estimateProbability({ ...args, spot: 0, annualizedVolPct: 60 }), null)
  assert.equal(estimateProbability({ ...args, spot: 100, annualizedVolPct: 0 }), null)
})

test('micro-usd converts to a probability and rejects degenerate prices', () => {
  assert.equal(impliedProbability(650_000), 0.65)
  assert.equal(impliedProbability(0), null)
  assert.equal(impliedProbability(1_000_000), null)
  assert.equal(impliedProbability(null), null)
})

test('expected value is positive only when our probability beats the price', () => {
  // 60% chance bought at 50c returns 20c per dollar.
  assert.ok(Math.abs(expectedValuePerDollar(0.6, 0.5)! - 0.2) < 1e-9)
  // Paying the fair price is a zero-EV bet.
  assert.equal(expectedValuePerDollar(0.5, 0.5), 0)
  assert.ok(expectedValuePerDollar(0.4, 0.5)! < 0)
})

test('stake breakdown reports contracts, payout and break-even', () => {
  const b = stakeBreakdown(25, 0.25)!
  assert.equal(b.contracts, 100)
  assert.equal(b.maxPayout, 100)
  assert.equal(b.maxProfit, 75)
  assert.equal(b.breakEvenProb, 0.25)
})

test('a clear mispricing on a liquid market is suggested', () => {
  const v = judgeEdge({
    yesPriceMicro: 300_000,
    noPriceMicro: 710_000,
    ourProbYes: 0.6,
    volumeUsd: 250_000,
    days: 45,
  })
  assert.equal(v.action, 'BUY_YES')
  assert.equal(v.best?.side, 'YES')
  assert.ok(v.best!.edgePct > 25)
  assert.ok(v.reasons.length >= 2)
})

test('an overpriced YES points at the NO side instead', () => {
  const v = judgeEdge({
    yesPriceMicro: 800_000,
    noPriceMicro: 210_000,
    ourProbYes: 0.4,
    volumeUsd: 250_000,
    days: 45,
  })
  assert.equal(v.action, 'BUY_NO')
  assert.equal(v.best?.side, 'NO')
})

test('a fairly priced market is skipped rather than traded', () => {
  const v = judgeEdge({
    yesPriceMicro: 600_000,
    noPriceMicro: 405_000,
    ourProbYes: 0.6,
    volumeUsd: 250_000,
    days: 45,
  })
  assert.equal(v.action, 'SKIP')
  assert.ok(v.reasons.some((r) => /no edge/i.test(r)))
})

test('an illiquid market is never suggested however big the edge', () => {
  const v = judgeEdge({
    yesPriceMicro: 200_000,
    noPriceMicro: 810_000,
    ourProbYes: 0.8,
    volumeUsd: 500,
    days: 30,
  })
  assert.equal(v.action, 'SKIP')
  assert.ok(v.cautions.some((c) => /may not be able to sell/i.test(c)))
})

test('a wide venue spread is called out', () => {
  const v = judgeEdge({
    yesPriceMicro: 550_000,
    noPriceMicro: 550_000,
    ourProbYes: 0.55,
    volumeUsd: 100_000,
    days: 30,
  })
  assert.ok(v.cautions.some((c) => /spread costs/i.test(c)))
})

test('no model estimate means no suggestion, not a guess', () => {
  const v = judgeEdge({
    yesPriceMicro: 400_000,
    noPriceMicro: 610_000,
    ourProbYes: null,
    volumeUsd: 100_000,
    days: 30,
  })
  assert.equal(v.action, 'SKIP')
  assert.equal(v.best, null)
  assert.ok(v.cautions.some((c) => /own view/i.test(c)))
})

test('a missing price is reported rather than assumed', () => {
  const v = judgeEdge({
    yesPriceMicro: null,
    noPriceMicro: 500_000,
    ourProbYes: 0.7,
    volumeUsd: 100_000,
    days: 30,
  })
  assert.equal(v.action, 'SKIP')
  assert.ok(v.cautions.some((c) => /two-sided price/i.test(c)))
})
