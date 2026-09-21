/**
 * Long-horizon market context built from the Postgres candle store.
 *
 * The council previously reasoned from ~30 hours of 15m candles, which cannot
 * tell a pullback in an uptrend from the start of a bear leg. This assembles a
 * year-plus of daily structure plus a 4h/1h/15m ladder so both the agents and
 * the manual trading desk see the same picture.
 */
import { klineService, type Interval } from './klineService'
import {
  buildLongHorizon,
  classifyRegime,
  readTimeframe,
  type LongHorizon,
  type MarketRegime,
  type TimeframeRead,
} from './marketContextMath'
import { logger } from '../../lib/logger'

export type { LongHorizon, TimeframeRead } from './marketContextMath'

export type MarketContext = {
  symbol: string
  updatedAt: string
  available: boolean
  /** How much history actually backs this read. */
  dataQuality: 'deep' | 'partial' | 'thin' | 'none'
  longHorizon: LongHorizon | null
  timeframes: TimeframeRead[]
  alignment: { bullish: number; bearish: number; total: number; score: number }
  regime: MarketRegime
  headline: string
  notes: string[]
}

const LADDER: Array<{ interval: Interval; bars: number }> = [
  { interval: '1d', bars: 400 },
  { interval: '4h', bars: 180 },
  { interval: '1h', bars: 200 },
  { interval: '15m', bars: 200 },
]

const CACHE_TTL_MS = 60_000
const cache = new Map<string, { at: number; ctx: MarketContext }>()

function describe(symbol: string, ctx: Omit<MarketContext, 'headline'>): string {
  if (!ctx.available) return `${symbol}: no stored history yet`
  const lh = ctx.longHorizon
  const parts: string[] = []

  if (lh) {
    parts.push(`${lh.trend} regime`)
    parts.push(`${lh.pctFromHigh52w.toFixed(0)}% from 52w high`)
    if (lh.return90dPct != null) parts.push(`90d ${lh.return90dPct >= 0 ? '+' : ''}${lh.return90dPct.toFixed(0)}%`)
  }

  const up = ctx.timeframes.filter((t) => t.bias === 'up').map((t) => t.interval)
  parts.push(up.length > 0 ? `${up.join('/')} bullish` : 'no bullish timeframe')

  return `${symbol}: ${parts.join(' · ')}`
}

async function build(symbol: string): Promise<MarketContext> {
  const reads = await Promise.all(
    LADDER.map(async ({ interval, bars }) => ({
      interval,
      candles: await klineService.getCandles(symbol, interval, bars),
    })),
  )

  const timeframes = reads.filter((r) => r.candles.length >= 15).map((r) => readTimeframe(r.interval, r.candles))
  const daily = reads.find((r) => r.interval === '1d')?.candles ?? []
  const longHorizon = buildLongHorizon(daily)

  const bullish = timeframes.filter((t) => t.bias === 'up').length
  const bearish = timeframes.filter((t) => t.bias === 'down').length
  const total = timeframes.length
  const score = total > 0 ? (bullish - bearish) / total : 0

  const notes: string[] = []
  if (total === 0) notes.push('Candle store has no usable history for this symbol yet')
  else if (total < LADDER.length) {
    notes.push(`Only ${total}/${LADDER.length} timeframes available — backfill still running`)
  }
  if (longHorizon == null && total > 0) notes.push('Daily history too shallow for 52-week context')

  const dataQuality: MarketContext['dataQuality'] =
    total === 0
      ? 'none'
      : longHorizon != null && longHorizon.coveredDays >= 300 && total === LADDER.length
        ? 'deep'
        : longHorizon != null
          ? 'partial'
          : 'thin'

  const partial: Omit<MarketContext, 'headline'> = {
    symbol,
    updatedAt: new Date().toISOString(),
    available: total > 0,
    dataQuality,
    longHorizon,
    timeframes,
    alignment: { bullish, bearish, total, score },
    regime: classifyRegime(longHorizon, timeframes, score),
    notes,
  }

  return { ...partial, headline: describe(symbol, partial) }
}

/** Multi-timeframe context for a Binance symbol, cached for a minute. */
export async function getMarketContext(binanceSymbol: string): Promise<MarketContext> {
  const symbol = binanceSymbol.replace('/', '').toUpperCase()
  const hit = cache.get(symbol)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.ctx

  try {
    const ctx = await build(symbol)
    cache.set(symbol, { at: Date.now(), ctx })
    return ctx
  } catch (err) {
    logger.warn({ err, symbol }, '[market-context] build failed')
    return {
      symbol,
      updatedAt: new Date().toISOString(),
      available: false,
      dataQuality: 'none',
      longHorizon: null,
      timeframes: [],
      alignment: { bullish: 0, bearish: 0, total: 0, score: 0 },
      regime: 'unknown',
      headline: `${symbol}: context unavailable`,
      notes: ['Failed to read the candle store'],
    }
  }
}

/** Compact form for LLM prompts and council rationales. */
export function summarizeContext(ctx: MarketContext): string {
  if (!ctx.available) return 'No long-horizon history available.'
  const lh = ctx.longHorizon
  const lines: string[] = []

  if (lh) {
    lines.push(
      `1y structure: ${lh.trend}, ${lh.pctFromHigh52w.toFixed(1)}% from 52w high, ` +
        `${lh.pctFromLow52w.toFixed(1)}% above 52w low, range position ${(lh.rangePosition * 100).toFixed(0)}%.`,
    )
    const ret = [
      lh.return30dPct != null ? `30d ${lh.return30dPct.toFixed(1)}%` : null,
      lh.return90dPct != null ? `90d ${lh.return90dPct.toFixed(1)}%` : null,
      lh.return365dPct != null ? `1y ${lh.return365dPct.toFixed(1)}%` : null,
    ].filter(Boolean)
    if (ret.length > 0) lines.push(`Returns: ${ret.join(', ')}.`)
    if (lh.annualizedVolPct != null) {
      lines.push(
        `Annualised vol ${lh.annualizedVolPct.toFixed(0)}%, worst 1y drawdown ${lh.maxDrawdown1yPct?.toFixed(0) ?? '—'}%.`,
      )
    }
    if (lh.goldenCross != null) lines.push(`Daily SMA50 ${lh.goldenCross ? 'above' : 'below'} SMA200.`)
  }

  for (const tf of ctx.timeframes) {
    lines.push(
      `${tf.interval}: ${tf.bias}, RSI ${tf.rsi14?.toFixed(0) ?? '—'}, ` +
        `ADX ${tf.adx?.toFixed(0) ?? '—'}, change ${tf.changePct?.toFixed(1) ?? '—'}%.`,
    )
  }

  lines.push(`Regime: ${ctx.regime}. Timeframe alignment ${ctx.alignment.bullish}/${ctx.alignment.total} bullish.`)
  return lines.join(' ')
}
