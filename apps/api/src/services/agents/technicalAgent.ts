/**
 * Council voter: Technical Analyst.
 * Computes RSI(14), EMA(9/21) cross, and a trend-strength score from live
 * Jupiter-aligned candles. Deterministic — used both as a vote and as the
 * "claim validation" baseline for the LLM strategist (LLM_trader pattern:
 * never trust AI numeric claims without a computed cross-check).
 *
 * Short-horizon candles decide the entry; the multi-timeframe context from the
 * candle store decides whether that entry is with or against the larger trend.
 */
import {
  getJupiterAlignedCandles,
  getJupiterLivePrice,
  type JupiterCandle,
} from '../dex/jupiterCandleService'
import { getMarketContext, type MarketContext } from '../market/marketContextService'
import { logger } from '../../lib/logger'

export type AgentVote = {
  vote: 'BUY' | 'HOLD' | 'AVOID'
  confidence: number
  reason: string
}

export type TechnicalSnapshot = AgentVote & {
  rsi14: number | null
  emaFast: number | null
  emaSlow: number | null
  emaCrossBull: boolean | null
  trendStrength: number
  change1hPct: number | null
  /** Null for symbols with no Binance history in the candle store. */
  context: MarketContext | null
}

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null
  const k = 2 / (period + 1)
  let out = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < values.length; i++) {
    out = values[i]! * k + out * (1 - k)
  }
  return out
}

function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null
  let gains = 0
  let losses = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!
    if (d >= 0) gains += d
    else losses -= d
  }
  let avgGain = gains / period
  let avgLoss = losses / period
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period
  }
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

/** Fraction of the last `n` candles closing above their open — cheap trend proxy. */
function trendStrengthScore(closes: number[], opens: number[], n = 20): number {
  const len = Math.min(n, closes.length)
  if (len === 0) return 0.5
  let up = 0
  for (let i = closes.length - len; i < closes.length; i++) {
    if (closes[i]! >= opens[i]!) up++
  }
  return up / len
}

/** Flat synthetic series when only live price is available — keeps RSI/EMA from crashing. */
function synthesizeFromLivePrice(price: number, count: number, intervalMs: number): JupiterCandle[] {
  const now = Date.now()
  const candles: JupiterCandle[] = []
  let p = price
  for (let i = 0; i < count; i++) {
    const openTime = now - (count - i) * intervalMs
    // Tiny wiggle so RSI is computable (neutral ~50)
    const drift = Math.sin(i / 4) * price * 0.001
    p = price + drift
    candles.push({
      openTime,
      open: p,
      high: p * 1.0015,
      low: p * 0.9985,
      close: p,
      volume: 0,
      closeTime: openTime + intervalMs - 1,
    })
  }
  const last = candles[candles.length - 1]
  if (last) last.close = price
  return candles
}

const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
}

async function resolveCandles(binanceSymbol: string): Promise<{
  candles: JupiterCandle[]
  degraded: boolean
  note?: string
}> {
  const key = binanceSymbol.toUpperCase()
  const attempts: Array<{ interval: string; limit: number }> = [
    { interval: '15m', limit: 120 },
    { interval: '5m', limit: 96 },
    { interval: '1h', limit: 72 },
    { interval: '1m', limit: 90 },
  ]

  for (const { interval, limit } of attempts) {
    try {
      const result = await getJupiterAlignedCandles(key, interval, limit)
      if (result.candles.length >= 14) {
        return {
          candles: result.candles,
          degraded: !!(result.degraded || result.stale),
          note: result.note,
        }
      }
      if (result.jupiterPrice && result.jupiterPrice > 0) {
        const ms = INTERVAL_MS[interval] ?? 900_000
        return {
          candles: synthesizeFromLivePrice(result.jupiterPrice, Math.max(30, limit / 2), ms),
          degraded: true,
          note: result.note ?? 'Live Jupiter price — limited OHLC history',
        }
      }
    } catch (err) {
      logger.debug({ err, binanceSymbol, interval }, '[technical-agent] candle interval failed')
    }
  }

  const live = await getJupiterLivePrice(key).catch(() => null)
  if (live?.price && live.price > 0) {
    return {
      candles: synthesizeFromLivePrice(live.price, 40, INTERVAL_MS['15m']!),
      degraded: true,
      note: 'Live price fallback — on-chain OHLC temporarily unavailable',
    }
  }

  throw new Error(`No candle or live price for ${key}`)
}

const cache = new Map<string, { at: number; snap: TechnicalSnapshot }>()
const CACHE_TTL_MS = 60_000

/**
 * Overlay the higher-timeframe picture on a short-horizon vote: reinforce
 * entries that run with the larger trend, block the ones fighting it.
 */
function applyContext(snap: TechnicalSnapshot, ctx: MarketContext | null): TechnicalSnapshot {
  if (!ctx?.available || ctx.dataQuality === 'thin' || ctx.dataQuality === 'none') return snap

  const parts = [snap.reason]
  let { vote, confidence } = snap
  const lh = ctx.longHorizon
  const score = ctx.alignment.score

  if (vote === 'BUY') {
    if (score <= -0.5) {
      vote = 'HOLD'
      confidence = 0.45
      parts.push(`Higher timeframes bearish (${ctx.alignment.bearish}/${ctx.alignment.total}) — entry against trend`)
    } else if (lh?.trend === 'bear' && (lh.rangePosition ?? 1) < 0.25) {
      confidence = Math.max(0.4, confidence - 0.15)
      parts.push(`1y downtrend, ${lh.pctFromHigh52w.toFixed(0)}% below 52w high — reduced conviction`)
    } else if (score >= 0.5 && lh?.trend === 'bull') {
      confidence = Math.min(0.95, confidence + 0.12)
      parts.push(`Aligned with 1y uptrend (${ctx.alignment.bullish}/${ctx.alignment.total} timeframes up)`)
    } else if (score >= 0.5) {
      confidence = Math.min(0.92, confidence + 0.06)
      parts.push(`${ctx.alignment.bullish}/${ctx.alignment.total} higher timeframes bullish`)
    }

    if (ctx.regime === 'high_volatility') {
      confidence = Math.max(0.4, confidence - 0.1)
      parts.push(`Volatility regime ${lh?.annualizedVolPct?.toFixed(0) ?? '—'}% annualised`)
    }
    if (ctx.regime === 'choppy') {
      confidence = Math.max(0.4, confidence - 0.05)
      parts.push('Choppy regime — ADX below trend threshold')
    }
  } else if (vote === 'HOLD' && score >= 0.75 && lh?.trend === 'bull') {
    // Higher timeframes alone never manufacture an entry, but they raise the
    // council's read on an otherwise neutral short-horizon picture.
    confidence = Math.min(0.6, confidence + 0.08)
    parts.push('All higher timeframes bullish — watching for entry trigger')
  }

  if (lh && lh.pctFromHigh52w > -2) parts.push('Trading at 52-week highs')

  return { ...snap, vote, confidence: Math.min(0.95, Math.max(0.3, confidence)), reason: parts.join(' · ') }
}

function analyzeCandles(
  candles: JupiterCandle[],
  opts: { degraded: boolean; note?: string },
): TechnicalSnapshot {
  const closes = candles.map((c) => c.close)
  const opens = candles.map((c) => c.open)

  const rsi14 = rsi(closes)
  const emaFast = ema(closes, 9)
  const emaSlow = ema(closes, 21)
  const emaCrossBull = emaFast != null && emaSlow != null ? emaFast > emaSlow : null
  const trendStrength = trendStrengthScore(closes, opens)
  const last = closes[closes.length - 1] ?? 0
  const fourBarsAgo = closes[closes.length - 5] ?? last
  const change1hPct = fourBarsAgo > 0 ? ((last - fourBarsAgo) / fourBarsAgo) * 100 : null

  let vote: AgentVote['vote'] = 'HOLD'
  let confidence = opts.degraded ? 0.42 : 0.5
  const parts: string[] = []

  if (opts.degraded) {
    parts.push(opts.note ?? 'Limited candle history')
  }

  if (rsi14 != null) {
    if (rsi14 > 78) {
      vote = 'AVOID'
      confidence = 0.7
      parts.push(`RSI ${rsi14.toFixed(0)} overbought`)
    } else if (rsi14 < 30) {
      parts.push(`RSI ${rsi14.toFixed(0)} oversold (mean-revert risk)`)
    } else if (rsi14 >= 50 && rsi14 <= 70) {
      parts.push(`RSI ${rsi14.toFixed(0)} healthy`)
      confidence += 0.1
    }
  }

  if (vote !== 'AVOID' && emaCrossBull != null) {
    if (emaCrossBull && trendStrength >= 0.55) {
      // Never vote BUY on degraded/synthetic candles — RSI/EMA computed from a
      // synthetic sine series is noise, not signal.
      if (opts.degraded) {
        parts.push('Uptrend hint but candle data degraded — holding')
      } else {
        vote = 'BUY'
        confidence = Math.min(
          0.9,
          0.55 +
            (trendStrength - 0.55) * 1.2 +
            (rsi14 != null && rsi14 > 50 && rsi14 < 70 ? 0.1 : 0),
        )
        parts.push(`EMA9>EMA21 uptrend, strength ${(trendStrength * 100).toFixed(0)}%`)
      }
    } else if (!emaCrossBull && trendStrength < 0.45) {
      vote = 'AVOID'
      confidence = 0.65
      parts.push(`EMA9<EMA21 downtrend, strength ${(trendStrength * 100).toFixed(0)}%`)
    } else {
      parts.push(`Mixed trend (strength ${(trendStrength * 100).toFixed(0)}%)`)
    }
  }

  return {
    vote,
    confidence: Math.min(0.95, Math.max(0.3, confidence)),
    reason: parts.join(' · ') || 'No clear technical edge',
    rsi14,
    emaFast,
    emaSlow,
    emaCrossBull,
    trendStrength,
    change1hPct,
    context: null,
  }
}

export async function technicalVote(binanceSymbol: string): Promise<TechnicalSnapshot> {
  const key = binanceSymbol.toUpperCase()
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.snap

  const context = await getMarketContext(key).catch(() => null)

  try {
    const { candles, degraded, note } = await resolveCandles(key)
    const snap = applyContext({ ...analyzeCandles(candles, { degraded, note }), context }, context)
    cache.set(key, { at: Date.now(), snap })
    return snap
  } catch (err) {
    logger.warn({ err, binanceSymbol }, '[technical-agent] all candle sources failed')
    const snap: TechnicalSnapshot = {
      vote: 'HOLD',
      confidence: 0.3,
      reason: 'Candle data unavailable',
      rsi14: null,
      emaFast: null,
      emaSlow: null,
      emaCrossBull: null,
      trendStrength: 0.5,
      change1hPct: null,
      context,
    }
    cache.set(key, { at: Date.now(), snap })
    return snap
  }
}
