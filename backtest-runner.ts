/**
 * Backtesting runner.
 * Replays historical klines through the indicator + Bayesian ensemble stack
 * (NOT the full meta-policy which requires live services) to estimate edge.
 *
 * Usage (ts-node):
 *   npx ts-node backtest/runner.ts --symbol BTCUSDT --from 2024-01-01
 */
import 'dotenv/config'
import { prisma } from '@cryptoflow/db'
import {
  ema, rsi, macd, bollinger, atr, obv, stochastic, linRegSlope, last,
} from '../apps/api/src/services/market/indicators'
import { computeMetrics } from './metrics'

const args = process.argv.slice(2)
const get = (flag: string, def: string) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : def
}

const SYMBOL   = get('--symbol', 'BTCUSDT')
const INTERVAL = get('--interval', '1h')
const FROM_STR = get('--from', '2024-01-01')
const TO_STR   = get('--to', new Date().toISOString().split('T')[0])
const BUY_THR  = parseFloat(get('--buy', '0.60'))
const SEL_THR  = parseFloat(get('--sell', '0.40'))

async function run() {
  const from = new Date(FROM_STR)
  const to   = new Date(TO_STR)

  console.log(`\nBacktest: ${SYMBOL} ${INTERVAL} from ${FROM_STR} to ${TO_STR}`)
  console.log(`Signal thresholds: BUY > ${BUY_THR}, SELL < ${SEL_THR}\n`)

  const bars = await prisma.kline.findMany({
    where: { symbol: SYMBOL, interval: INTERVAL, openTime: { gte: from, lte: to } },
    orderBy: { openTime: 'asc' },
  })

  if (bars.length < 50) {
    console.error(`Not enough bars: ${bars.length}. Run the API first to backfill data.`)
    process.exit(1)
  }

  const closes  = bars.map((b) => Number(b.close))
  const highs   = bars.map((b) => Number(b.high))
  const lows    = bars.map((b) => Number(b.low))
  const volumes = bars.map((b) => Number(b.volume))

  const ema20    = ema(closes, 20)
  const ema50    = ema(closes, 50)
  const rsi14    = rsi(closes, 14)
  const { hist: macdHist } = macd(closes)
  const { upper: bbUpper, lower: bbLower, middle: bbMid } = bollinger(closes, 20, 2)
  const atr14    = atr(highs, lows, closes, 14)
  const obvArr   = obv(closes, volumes)
  const slope5   = linRegSlope(closes, 5)

  // Rolling Bayesian-style score — simple heuristic (no DB priors in backtest)
  function scoreBar(i: number): number {
    let score = 0.5  // neutral prior

    // EMA signal
    if (!isNaN(ema20[i]) && !isNaN(ema50[i])) {
      const r = ema20[i] / ema50[i]
      if (r > 1.001) score += 0.07
      else if (r < 0.999) score -= 0.07
    }

    // RSI
    if (!isNaN(rsi14[i])) {
      if (rsi14[i] < 35) score += 0.08
      else if (rsi14[i] > 65) score -= 0.08
    }

    // MACD hist
    if (!isNaN(macdHist[i]) && !isNaN(macdHist[i - 1])) {
      if (macdHist[i] > 0 && macdHist[i] > macdHist[i - 1]) score += 0.05
      if (macdHist[i] < 0 && macdHist[i] < macdHist[i - 1]) score -= 0.05
    }

    // Bollinger
    if (!isNaN(bbUpper[i]) && !isNaN(bbLower[i])) {
      const pos = (closes[i] - bbLower[i]) / (bbUpper[i] - bbLower[i])
      if (pos < 0.1) score += 0.05
      if (pos > 0.9) score -= 0.05
    }

    // Volume spike + slope
    if (!isNaN(slope5[i])) {
      const avgVol = volumes.slice(Math.max(0, i - 20), i).reduce((a, b) => a + b, 0) / 20
      const volRatio = avgVol > 0 ? volumes[i] / avgVol : 1
      if (volRatio > 1.5 && slope5[i] > 0) score += 0.05
      if (volRatio > 1.5 && slope5[i] < 0) score -= 0.05
    }

    return Math.max(0, Math.min(1, score))
  }

  // Simulate trading
  let position: 'NONE' | 'LONG' = 'NONE'
  let entryPrice = 0
  let entryIdx = 0
  const trades: { pnl: number; bars: number }[] = []
  const dailyReturns: number[] = []
  let dayPnl = 0
  let lastDay = bars[0]?.openTime?.toDateString() ?? ''

  for (let i = 50; i < bars.length - 1; i++) {
    const price = closes[i]
    const day = bars[i].openTime.toDateString()
    if (day !== lastDay) {
      dailyReturns.push(dayPnl)
      dayPnl = 0
      lastDay = day
    }

    const pUp = scoreBar(i)

    // ATR stop-loss
    if (position === 'LONG' && !isNaN(atr14[i])) {
      const stop = entryPrice - 2 * atr14[i]
      if (price < stop) {
        const pnl = price - entryPrice
        trades.push({ pnl, bars: i - entryIdx })
        dayPnl += pnl
        position = 'NONE'
        continue
      }
    }

    if (pUp > BUY_THR && position === 'NONE') {
      position   = 'LONG'
      entryPrice = price
      entryIdx   = i
    } else if (pUp < SEL_THR && position === 'LONG') {
      const pnl = price - entryPrice
      trades.push({ pnl, bars: i - entryIdx })
      dayPnl += pnl
      position = 'NONE'
    }
  }

  // Close any open position at end
  if (position === 'LONG') {
    const pnl = closes[closes.length - 1] - entryPrice
    trades.push({ pnl, bars: bars.length - 1 - entryIdx })
  }

  await prisma.$disconnect()

  const metrics = computeMetrics(dailyReturns, trades)

  console.log('─────────────────────────────────────')
  console.log(`Total trades:    ${metrics.totalTrades}`)
  console.log(`Win rate:        ${(metrics.winRate * 100).toFixed(1)}%`)
  console.log(`Profit factor:   ${metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2)}`)
  console.log(`Total PnL:       ${metrics.totalReturn.toFixed(2)} USDT (raw)`)
  console.log(`Sharpe ratio:    ${metrics.sharpeRatio.toFixed(3)}`)
  console.log(`Sortino ratio:   ${metrics.sortinoRatio.toFixed(3)}`)
  console.log(`Max drawdown:    ${(metrics.maxDrawdown * 100).toFixed(2)}%`)
  console.log(`Avg win:         ${metrics.avgWin.toFixed(4)}`)
  console.log(`Avg loss:        ${metrics.avgLoss.toFixed(4)}`)
  console.log('─────────────────────────────────────')

  // Gate suggestion
  const pass = metrics.sharpeRatio > 1.0 && metrics.maxDrawdown < 0.25 && metrics.profitFactor > 1.3
  console.log(pass
    ? '✓ Metrics pass promotion gate (Sharpe > 1.0, DD < 25%, PF > 1.3)'
    : '✗ Does NOT pass gate — tune before promoting to live')
}

run().catch((err) => { console.error(err); process.exit(1) })
