/**
 * Prior backfill: compute indicators directly from Kline rows and update
 * BayesPrior Beta parameters before the first live trade.
 *
 * The Feature table is only populated on live kline closes — so at startup
 * we bypass it and compute signals inline from the raw Kline data.
 */
import { prisma } from '@cryptoflow/db'
import { logger } from '../../lib/logger'
import { ema, rsi, macd, bollinger, linRegSlope } from '../market/indicators'

type Direction = 'UP' | 'DOWN' | 'NEUTRAL'

interface Bar {
  open:   number
  high:   number
  low:    number
  close:  number
  volume: number
}

interface Features {
  ema20:       number
  ema50:       number
  rsi14:       number
  macdHist:    number
  macdHistPrev:number
  bbPos:       number
  volRatio:    number
  slope5:      number
}

function computeFeatures(bars: Bar[], idx: number): Features | null {
  if (idx < 52) return null  // need at least 52 bars for MACD(26) + signal(9) + buffer

  const slice  = bars.slice(0, idx + 1)
  const closes = slice.map((b) => b.close)
  const volumes= slice.map((b) => b.volume)

  const ema20Arr = ema(closes, 20)
  const ema50Arr = ema(closes, 50)
  const rsi14Arr = rsi(closes, 14)
  const { hist }  = macd(closes, 12, 26, 9)
  const { upper, lower } = bollinger(closes, 20, 2)
  const slope5Arr = linRegSlope(closes, 5)

  const last = (arr: number[]) => {
    for (let i = arr.length - 1; i >= 0; i--) if (!isNaN(arr[i])) return arr[i]
    return NaN
  }

  const e20 = last(ema20Arr)
  const e50 = last(ema50Arr)
  const bbU = last(upper)
  const bbL = last(lower)
  const h   = last(hist)
  const hPrev = hist.length >= 2 ? hist[hist.length - 2] : NaN
  const cl  = closes[closes.length - 1]

  const recent  = volumes.slice(-20)
  const avgVol  = recent.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(1, recent.length - 1)
  const volRatio= avgVol > 0 ? volumes[volumes.length - 1] / avgVol : 1

  return {
    ema20:        e20,
    ema50:        e50,
    rsi14:        last(rsi14Arr),
    macdHist:     h,
    macdHistPrev: hPrev,
    bbPos:        (bbU - bbL) > 0 ? (cl - bbL) / (bbU - bbL) : 0.5,
    volRatio,
    slope5:       last(slope5Arr),
  }
}

const EVALUATORS: Record<string, (f: Features) => Direction> = {
  ema: (f) => {
    if (isNaN(f.ema20) || isNaN(f.ema50)) return 'NEUTRAL'
    const r = f.ema20 / f.ema50
    if (r > 1.003) return 'UP'
    if (r < 0.997) return 'DOWN'
    return 'NEUTRAL'
  },
  rsi: (f) => {
    if (isNaN(f.rsi14)) return 'NEUTRAL'
    if (f.rsi14 < 35) return 'UP'
    if (f.rsi14 > 65) return 'DOWN'
    return 'NEUTRAL'
  },
  macd: (f) => {
    // Use magnitude-expansion logic — matches live macdSignal.ts exactly
    if (isNaN(f.macdHist) || isNaN(f.macdHistPrev)) return 'NEUTRAL'
    const expanding = Math.abs(f.macdHist) > Math.abs(f.macdHistPrev)
    if (f.macdHist > 0 && expanding) return 'UP'
    if (f.macdHist < 0 && expanding) return 'DOWN'
    return 'NEUTRAL'
  },
  bollinger: (f) => {
    if (isNaN(f.bbPos)) return 'NEUTRAL'
    if (f.bbPos < 0.10) return 'UP'
    if (f.bbPos > 0.90) return 'DOWN'
    return 'NEUTRAL'
  },
  volume: (f) => {
    if (isNaN(f.volRatio) || isNaN(f.slope5)) return 'NEUTRAL'
    if (f.volRatio > 1.5 && f.slope5 > 0) return 'UP'
    if (f.volRatio > 1.5 && f.slope5 < 0) return 'DOWN'
    return 'NEUTRAL'
  },
}

const SOURCES   = Object.keys(EVALUATORS)
const SYMBOLS   = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT']
const INTERVALS = ['1h']

async function isCold(symbol: string, interval: string): Promise<boolean> {
  const count = await prisma.bayesPrior.count({
    where: { symbol, interval, alphaUp: { gt: 2 } },
  })
  return count === 0
}

async function backfillSymbol(symbol: string, interval: string) {
  logger.info(`[priorBackfill] Backfilling ${symbol} ${interval} from Kline data...`)

  const rows = await prisma.kline.findMany({
    where: { symbol, interval },
    orderBy: { openTime: 'asc' },
    select: { open: true, high: true, low: true, close: true, volume: true },
  })

  if (rows.length < 60) {
    logger.warn(`[priorBackfill] Not enough klines for ${symbol} ${interval}: ${rows.length}`)
    return
  }

  const bars: Bar[] = rows.map((r) => ({
    open:   Number(r.open),
    high:   Number(r.high),
    low:    Number(r.low),
    close:  Number(r.close),
    volume: Number(r.volume),
  }))

  const counts: Record<string, { alphaUp: number; betaUp: number; alphaDown: number; betaDown: number }> =
    Object.fromEntries(SOURCES.map((s) => [s, { alphaUp: 0, betaUp: 0, alphaDown: 0, betaDown: 0 }]))

  let processed = 0

  for (let i = 52; i < bars.length - 1; i++) {
    const f = computeFeatures(bars, i)
    if (!f) continue

    const nextBar  = bars[i + 1]
    const actualUp = nextBar.close >= nextBar.open

    for (const source of SOURCES) {
      const dir = EVALUATORS[source](f)
      if (dir === 'NEUTRAL') continue

      const wasBullish = dir === 'UP'
      const c = counts[source]
      if (wasBullish  && actualUp)  c.alphaUp++
      if (wasBullish  && !actualUp) c.betaUp++
      if (!wasBullish && !actualUp) c.alphaDown++
      if (!wasBullish && actualUp)  c.betaDown++
    }

    processed++
  }

  for (const source of SOURCES) {
    const c = counts[source]
    const total = c.alphaUp + c.betaUp + c.alphaDown + c.betaDown
    if (total === 0) continue

    await prisma.bayesPrior.upsert({
      where: { signalSource_symbol_interval: { signalSource: source, symbol, interval } },
      create: {
        signalSource: source,
        symbol,
        interval,
        alphaUp:   1 + c.alphaUp,
        betaUp:    1 + c.betaUp,
        alphaDown: 1 + c.alphaDown,
        betaDown:  1 + c.betaDown,
      },
      update: {
        alphaUp:   { increment: c.alphaUp },
        betaUp:    { increment: c.betaUp },
        alphaDown: { increment: c.alphaDown },
        betaDown:  { increment: c.betaDown },
      },
    })

    const accuracy = ((c.alphaUp + c.alphaDown) / total * 100).toFixed(1)
    logger.info(
      `[priorBackfill] ${symbol}/${interval}/${source}: ` +
      `↑win=${c.alphaUp} ↑loss=${c.betaUp} ↓win=${c.alphaDown} ↓loss=${c.betaDown} ` +
      `accuracy=${accuracy}% (n=${total})`
    )
  }

  logger.info(`[priorBackfill] Done ${symbol} ${interval}: processed ${processed} bars`)
}

export async function runPriorBackfill(): Promise<void> {
  for (const symbol of SYMBOLS) {
    for (const interval of INTERVALS) {
      const cold = await isCold(symbol, interval)
      if (!cold) {
        logger.info(`[priorBackfill] ${symbol} ${interval} already warm, skipping`)
        continue
      }
      await backfillSymbol(symbol, interval)
    }
  }
}
