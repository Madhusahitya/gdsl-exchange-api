/**
 * Feature engine: computes technical indicators on closed klines and
 * upserts into the Feature table for downstream signal sources.
 */
import { prisma } from '@cryptoflow/db'
import { logger } from '../../lib/logger'
import {
  ema, rsi, macd, bollinger, atr, obv, stochastic, linRegSlope, last,
} from './indicators'

const LOOKBACK = 200  // bars to pull for computation

async function computeAndStore(symbol: string, interval: string) {
  const rows = await prisma.kline.findMany({
    where: { symbol, interval },
    orderBy: { openTime: 'desc' },
    take: LOOKBACK,
    select: { openTime: true, open: true, high: true, low: true, close: true, volume: true, quoteVolume: true },
  })

  if (rows.length < 50) {
    logger.warn(`[features] Not enough bars for ${symbol} ${interval}: ${rows.length}`)
    return
  }

  // Reverse to chronological order (oldest first) — use spread to avoid mutating Prisma's array
  const bars = [...rows].reverse()
  const closes  = bars.map((b) => Number(b.close))
  const highs   = bars.map((b) => Number(b.high))
  const lows    = bars.map((b) => Number(b.low))
  const volumes = bars.map((b) => Number(b.volume))

  // Compute indicators
  const ema20  = ema(closes, 20)
  const ema50  = ema(closes, 50)
  const ema200 = ema(closes, 200)
  const rsi14  = rsi(closes, 14)
  const { macd: macdLine, signal: macdSignal, hist: macdHist } = macd(closes)
  const { upper: bbUpper, middle: bbMid, lower: bbLower } = bollinger(closes, 20, 2)
  const atr14  = atr(highs, lows, closes, 14)
  const obvArr = obv(closes, volumes)
  const { k: stochK, d: stochD } = stochastic(highs, lows, closes, 14, 3)
  const slope5 = linRegSlope(closes, 5)

  const lastClose  = closes[closes.length - 1]
  const lastBbMid  = last(bbMid)

  const payload = {
    ema20:         last(ema20),
    ema50:         last(ema50),
    ema200:        last(ema200),
    ema20Rel:      lastClose / (last(ema20) || 1) - 1,
    ema50Rel:      lastClose / (last(ema50) || 1) - 1,
    rsi14:         last(rsi14),
    macd:          last(macdLine),
    macdSignal:    last(macdSignal),
    macdHist:      last(macdHist),
    macdHistPrev:  macdHist[macdHist.length - 2],
    bbUpper:       last(bbUpper),
    bbMid:         lastBbMid,
    bbLower:       last(bbLower),
    bbPos:         lastBbMid ? (lastClose - last(bbLower)) / (last(bbUpper) - last(bbLower) || 1) : 0.5,
    atr14:         last(atr14),
    atr14Rel:      lastClose > 0 ? last(atr14) / lastClose : 0,
    obv:           last(obvArr),
    obvSlope:      last(linRegSlope(obvArr, 5)),
    stochK:        last(stochK),
    stochD:        last(stochD),
    slope5:        last(slope5),
    // Volume spike ratio (last bar vs avg of prior 20)
    volRatio:      (() => {
      const recent = volumes.slice(-20)
      const avg = recent.slice(0, -1).reduce((a, b) => a + b, 0) / (recent.length - 1)
      return avg > 0 ? volumes[volumes.length - 1] / avg : 1
    })(),
  }

  const ts = bars[bars.length - 1].openTime

  await prisma.feature.upsert({
    where: { symbol_interval_ts: { symbol, interval, ts } },
    create: { symbol, interval, ts, payload },
    update: { payload },
  })

  logger.debug(`[features] Computed ${symbol} ${interval} @ ${ts.toISOString()}`)
}

export const featureEngine = {
  async onKlineClose(symbol: string, interval: string) {
    await computeAndStore(symbol, interval)
  },

  /** Get latest feature payload for a symbol/interval */
  async getLatest(symbol: string, interval: string) {
    const row = await prisma.feature.findFirst({
      where: { symbol, interval },
      orderBy: { ts: 'desc' },
    })
    return row?.payload as Record<string, number> | null
  },
}
