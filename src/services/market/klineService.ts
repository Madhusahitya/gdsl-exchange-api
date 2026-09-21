/**
 * Kline (OHLCV) ingestion service.
 *
 * Maintains a multi-timeframe candle store in Postgres for the tracked Binance
 * USDT universe. Deep history — up to two years of daily bars — is what lets
 * the agent council reason about a market beyond the last few hours.
 *
 * Ingestion has three parts:
 *  - a progressive background backfill that walks history backwards,
 *  - websocket streams for the core symbols on the fast intervals,
 *  - a round-robin REST refresh that keeps the whole universe current.
 *
 * Only closed bars are ever stored, so rows are immutable once written and
 * bulk inserts can skip duplicates instead of upserting row by row.
 */
import EventEmitter from 'events'
import WebSocket from 'ws'
import { prisma } from '@cryptoflow/db'
import { logger } from '../../lib/logger'
import { featureEngine } from './featureEngine'
import { BinanceRestLimiter, klineRequestWeight } from './binanceRestLimiter'
import {
  CORE_SYMBOLS,
  getTrackedSymbols,
  getTrackedSymbolsSync,
} from './binanceSymbolUniverse'

// Exported emitter — advancedBot listens for 'kline:closed' events
export const klineEmitter = new EventEmitter()

const BINANCE_REST = 'https://api.binance.com'
const BINANCE_WS = 'wss://stream.binance.com:9443'

/** Retained for the order-book service, which warms the same pinned markets. */
export const SYMBOLS = CORE_SYMBOLS

export const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const
export type Interval = (typeof INTERVALS)[number]

const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
}

type IntervalConfig = {
  /** Bars of history to backfill per symbol. */
  targetBars: number
  /** Track across the whole universe, or only the pinned core symbols? */
  scope: 'universe' | 'core'
  /** Drop bars older than this many days; null keeps history forever. */
  retentionDays: number | null
  /** Open a live websocket stream (core symbols only). */
  stream: boolean
  /** Backfill ordering — lower runs first. */
  priority: number
}

/**
 * Retention must always exceed the backfill target, otherwise pruning and
 * backfill fight each other forever.
 */
const INTERVAL_CONFIG: Record<Interval, IntervalConfig> = {
  '1d': { targetBars: 730, scope: 'universe', retentionDays: null, stream: false, priority: 3 },
  '4h': { targetBars: 1200, scope: 'universe', retentionDays: 1200, stream: false, priority: 2 },
  '1h': { targetBars: 2000, scope: 'universe', retentionDays: 400, stream: true, priority: 0 },
  '15m': { targetBars: 1500, scope: 'universe', retentionDays: 60, stream: true, priority: 1 },
  '5m': { targetBars: 1000, scope: 'core', retentionDays: 14, stream: false, priority: 4 },
  '1m': { targetBars: 1500, scope: 'core', retentionDays: 5, stream: true, priority: 5 },
}

const UNIVERSE_INTERVALS = INTERVALS.filter((i) => INTERVAL_CONFIG[i].scope === 'universe')
const REFRESH_CYCLE_MS = 20_000
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000
const UNIVERSE_REFRESH_MS = 60 * 60 * 1000

const limiter = new BinanceRestLimiter(Number(process.env.KLINE_BINANCE_WEIGHT_BUDGET) || 1_200)

interface BinanceKline {
  t: number // open time ms
  i?: string // interval (websocket payloads only)
  o: string
  h: string
  l: string
  c: string
  v: string
  q: string // quote asset volume
  n: number // number of trades
  x: boolean // is bar closed?
}

function asInterval(value: string | undefined): Interval | null {
  return value && (INTERVALS as readonly string[]).includes(value) ? (value as Interval) : null
}

// ─── REST ingestion ──────────────────────────────────────────────────

async function fetchKlines(
  symbol: string,
  interval: Interval,
  limit = 1000,
  opts: { endTime?: number; startTime?: number } = {},
): Promise<BinanceKline[]> {
  const params = new URLSearchParams({ symbol, interval, limit: String(limit) })
  if (opts.endTime) params.set('endTime', String(opts.endTime))
  if (opts.startTime) params.set('startTime', String(opts.startTime))

  await limiter.acquire(klineRequestWeight(limit))

  const res = await fetch(`${BINANCE_REST}/api/v3/klines?${params}`)
  if (!res.ok) throw new Error(`Binance klines fetch failed for ${symbol} ${interval}: ${res.status}`)

  // raw format: [openTime, open, high, low, close, volume, closeTime, quoteVol, trades, ...]
  const raw = (await res.json()) as unknown[][]
  const closedBefore = Date.now() - INTERVAL_MS[interval]

  return raw
    .map((r) => ({
      t: r[0] as number,
      o: r[1] as string,
      h: r[2] as string,
      l: r[3] as string,
      c: r[4] as string,
      v: r[5] as string,
      q: r[7] as string,
      n: r[8] as number,
      x: true,
    }))
    // Binance returns the in-progress candle last; storing it would freeze a
    // partial bar in place because inserts skip duplicates.
    .filter((k) => k.t <= closedBefore)
}

function toRows(symbol: string, interval: Interval, candles: BinanceKline[]) {
  return candles.map((k) => ({
    symbol,
    interval,
    openTime: new Date(k.t),
    open: k.o,
    high: k.h,
    low: k.l,
    close: k.c,
    volume: k.v,
    quoteVolume: k.q,
    trades: k.n,
  }))
}

/** Bulk insert closed bars. Returns how many were genuinely new. */
async function writeKlines(symbol: string, interval: Interval, candles: BinanceKline[]): Promise<number> {
  if (candles.length === 0) return 0
  const { count } = await prisma.kline.createMany({
    data: toRows(symbol, interval, candles),
    skipDuplicates: true,
  })
  return count
}

function notifyBarClosed(symbol: string, interval: Interval) {
  klineEmitter.emit('kline:closed', { symbol, interval })
  featureEngine
    .onKlineClose(symbol, interval)
    .catch((err) => logger.error({ err }, `[features] recompute error ${symbol} ${interval}`))
}

// ─── Backfill ────────────────────────────────────────────────────────

/** Walk history backwards until the configured depth is covered. */
async function backfillHistory(symbol: string, interval: Interval): Promise<number> {
  const { targetBars } = INTERVAL_CONFIG[interval]
  const targetOldest = Date.now() - targetBars * INTERVAL_MS[interval]

  const oldest = await prisma.kline.findFirst({
    where: { symbol, interval },
    orderBy: { openTime: 'asc' },
    select: { openTime: true },
  })

  if (oldest && oldest.openTime.getTime() <= targetOldest) return 0

  let endTime = oldest ? oldest.openTime.getTime() - 1 : undefined
  let written = 0

  for (let page = 0; page < 40; page += 1) {
    const candles = await fetchKlines(symbol, interval, 1000, { endTime })
    if (candles.length === 0) break

    written += await writeKlines(symbol, interval, candles)
    endTime = candles[0].t - 1

    if (candles.length < 1000) break // reached the start of the listing
    if (candles[0].t <= targetOldest) break
  }

  return written
}

/** Fill everything between the newest stored bar and now. */
async function syncForward(symbol: string, interval: Interval): Promise<number> {
  const step = INTERVAL_MS[interval]
  let written = 0

  for (let page = 0; page < 10; page += 1) {
    const newest = await prisma.kline.findFirst({
      where: { symbol, interval },
      orderBy: { openTime: 'desc' },
      select: { openTime: true },
    })

    if (!newest) {
      written += await writeKlines(symbol, interval, await fetchKlines(symbol, interval, 1000))
      break
    }

    const missing = Math.floor((Date.now() - newest.openTime.getTime()) / step) - 1
    if (missing <= 0) break

    const limit = Math.min(1000, missing + 1)
    const candles = await fetchKlines(symbol, interval, limit, {
      startTime: newest.openTime.getTime() + 1,
    })
    if (candles.length === 0) break

    written += await writeKlines(symbol, interval, candles)
    if (candles.length < limit) break
  }

  return written
}

type BackfillJob = { symbol: string; interval: Interval; priority: number }

const completedJobs = new Set<string>()
let backfillRunning = false

function jobKey(symbol: string, interval: Interval): string {
  return `${symbol}|${interval}`
}

async function buildBackfillQueue(): Promise<BackfillJob[]> {
  const symbols = await getTrackedSymbols()
  const jobs: BackfillJob[] = []

  for (const interval of INTERVALS) {
    const cfg = INTERVAL_CONFIG[interval]
    const scoped = cfg.scope === 'core' ? CORE_SYMBOLS : symbols
    scoped.forEach((symbol, symbolRank) => {
      if (completedJobs.has(jobKey(symbol, interval))) return
      // Core symbols lead each interval so the primary markets are usable first.
      const coreRank = CORE_SYMBOLS.includes(symbol) ? 0 : 1
      jobs.push({ symbol, interval, priority: cfg.priority * 1000 + coreRank * 500 + symbolRank })
    })
  }

  return jobs.sort((a, b) => a.priority - b.priority)
}

/**
 * Runs the outstanding backfill work in the background. Deliberately not
 * awaited at boot: the API must come up immediately, and the store fills in
 * behind it over the following minutes.
 */
async function runBackfill(): Promise<void> {
  if (backfillRunning) return
  backfillRunning = true

  try {
    const jobs = await buildBackfillQueue()
    if (jobs.length === 0) return

    logger.info({ jobs: jobs.length }, '[kline] backfill starting')
    const startedAt = Date.now()
    let done = 0
    let barsWritten = 0

    for (const job of jobs) {
      try {
        barsWritten += await backfillHistory(job.symbol, job.interval)
        barsWritten += await syncForward(job.symbol, job.interval)
        completedJobs.add(jobKey(job.symbol, job.interval))
      } catch (err) {
        logger.warn({ err }, `[kline] backfill failed for ${job.symbol} ${job.interval}`)
      }

      done += 1
      if (done % 25 === 0 || done === jobs.length) {
        logger.info(
          { done, total: jobs.length, barsWritten, elapsedSec: Math.round((Date.now() - startedAt) / 1000) },
          '[kline] backfill progress',
        )
      }
    }

    logger.info(
      { barsWritten, elapsedSec: Math.round((Date.now() - startedAt) / 1000) },
      '[kline] backfill complete',
    )
  } finally {
    backfillRunning = false
  }
}

// ─── Live websocket streams (core symbols) ───────────────────────────

function openCombinedStream(streams: string[]): void {
  if (streams.length === 0) return
  const url = `${BINANCE_WS}/stream?streams=${streams.join('/')}`
  const ws = new WebSocket(url)

  ws.on('open', () => logger.info({ streams: streams.length }, '[kline] WS connected'))

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { data?: { s?: string; k?: BinanceKline } }
      const k = msg.data?.k
      const symbol = msg.data?.s
      if (!k || !symbol || !k.x) return // only closed bars

      const interval = asInterval(k.i)
      if (!interval) return

      const written = await writeKlines(symbol, interval, [k])
      if (written > 0) notifyBarClosed(symbol, interval)
    } catch (err) {
      logger.error({ err }, '[kline] WS message error')
    }
  })

  ws.on('error', (err) => logger.error({ err }, '[kline] WS error'))

  ws.on('close', () => {
    logger.warn('[kline] WS closed, reconnecting in 5s')
    setTimeout(() => openCombinedStream(streams), 5_000)
  })
}

function startStreams(): void {
  const streams: string[] = []
  for (const interval of INTERVALS) {
    if (!INTERVAL_CONFIG[interval].stream) continue
    for (const symbol of CORE_SYMBOLS) {
      streams.push(`${symbol.toLowerCase()}@kline_${interval}`)
    }
  }

  // Chunked so one dropped connection never takes the whole core feed down.
  const chunkSize = 25
  for (let i = 0; i < streams.length; i += chunkSize) {
    openCombinedStream(streams.slice(i, i + chunkSize))
  }
}

// ─── Round-robin REST refresh (whole universe) ───────────────────────

let refreshCursor = 0

/**
 * Websockets only cover the core symbols, so the wider universe is kept fresh
 * with a slow rotation through the tracked pairs. A slice at a time keeps the
 * Binance weight budget flat regardless of universe size.
 */
async function refreshCycle(): Promise<void> {
  const symbols = getTrackedSymbolsSync()
  if (symbols.length === 0) return

  const sliceSize = Math.max(4, Math.ceil(symbols.length / 12))
  const slice: string[] = []
  for (let i = 0; i < sliceSize; i += 1) {
    slice.push(symbols[(refreshCursor + i) % symbols.length])
  }
  refreshCursor = (refreshCursor + sliceSize) % symbols.length

  for (const symbol of slice) {
    for (const interval of UNIVERSE_INTERVALS) {
      try {
        const candles = await fetchKlines(symbol, interval, 5)
        const written = await writeKlines(symbol, interval, candles)
        if (written > 0) notifyBarClosed(symbol, interval)
      } catch (err) {
        logger.debug({ err }, `[kline] refresh failed ${symbol} ${interval}`)
      }
    }
  }
}

// ─── Retention ───────────────────────────────────────────────────────

async function pruneOldBars(): Promise<void> {
  for (const interval of INTERVALS) {
    const { retentionDays } = INTERVAL_CONFIG[interval]
    if (retentionDays == null) continue
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    try {
      const { count } = await prisma.kline.deleteMany({
        where: { interval, openTime: { lt: cutoff } },
      })
      if (count > 0) logger.info({ interval, count }, '[kline] pruned expired bars')
    } catch (err) {
      logger.warn({ err }, `[kline] prune failed for ${interval}`)
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────

export type Candle = {
  openTime: Date
  open: number
  high: number
  low: number
  close: number
  volume: number
  quoteVolume: number
  trades: number
}

export const klineService = {
  async start() {
    await getTrackedSymbols(true).catch(() => undefined)

    startStreams()

    // Backfill is intentionally not awaited — the API serves traffic while the
    // store deepens behind it.
    void runBackfill().catch((err) => logger.error({ err }, '[kline] backfill crashed'))

    setInterval(() => {
      void refreshCycle().catch((err) => logger.debug({ err }, '[kline] refresh cycle error'))
    }, REFRESH_CYCLE_MS)

    setInterval(() => {
      void getTrackedSymbols(true)
        .then(() => runBackfill())
        .catch((err) => logger.warn({ err }, '[kline] universe refresh cycle failed'))
    }, UNIVERSE_REFRESH_MS)

    setInterval(() => {
      void pruneOldBars()
    }, PRUNE_INTERVAL_MS)

    logger.info(
      { symbols: getTrackedSymbolsSync().length, intervals: INTERVALS.join(',') },
      '[kline] candle store started',
    )
  },

  /** Fetch last N closed bars from DB (newest last). */
  async getRecent(symbol: string, interval: string, limit: number) {
    const rows = await prisma.kline.findMany({
      where: { symbol, interval },
      orderBy: { openTime: 'desc' },
      take: limit,
    })
    return rows.reverse()
  },

  /** Numeric candles ready for indicator math (oldest first). */
  async getCandles(symbol: string, interval: Interval | string, limit: number): Promise<Candle[]> {
    const rows = await prisma.kline.findMany({
      where: { symbol, interval },
      orderBy: { openTime: 'desc' },
      take: Math.min(2000, Math.max(1, limit)),
      select: {
        openTime: true,
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true,
        quoteVolume: true,
        trades: true,
      },
    })

    return rows.reverse().map((r) => ({
      openTime: r.openTime,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
      quoteVolume: Number(r.quoteVolume),
      trades: r.trades,
    }))
  },

  /**
   * One call for the long-horizon view the council needs: a year-plus of daily
   * context down to the current 15m structure.
   */
  async getMultiTimeframe(
    symbol: string,
    request: Partial<Record<Interval, number>> = { '1d': 365, '4h': 180, '1h': 168, '15m': 96 },
  ): Promise<Partial<Record<Interval, Candle[]>>> {
    const entries = Object.entries(request) as Array<[Interval, number]>
    const results = await Promise.all(
      entries.map(
        async ([interval, limit]) =>
          [interval, await klineService.getCandles(symbol, interval, limit)] as const,
      ),
    )
    return Object.fromEntries(results) as Partial<Record<Interval, Candle[]>>
  },

  /** Ensure a symbol has history now, rather than waiting for its backfill slot. */
  async ensureSymbol(symbol: string, intervals: Interval[] = [...UNIVERSE_INTERVALS]): Promise<void> {
    for (const interval of intervals) {
      const key = jobKey(symbol, interval)
      if (completedJobs.has(key)) continue
      try {
        await backfillHistory(symbol, interval)
        await syncForward(symbol, interval)
        completedJobs.add(key)
      } catch (err) {
        logger.warn({ err }, `[kline] on-demand backfill failed ${symbol} ${interval}`)
      }
    }
  },

  /** Observability: how deep the store actually is right now. */
  async getCoverage() {
    const grouped = await prisma.kline.groupBy({
      by: ['symbol', 'interval'],
      _count: { _all: true },
      _min: { openTime: true },
      _max: { openTime: true },
    })

    return {
      trackedSymbols: getTrackedSymbolsSync(),
      intervals: INTERVALS.map((interval) => ({
        interval,
        ...INTERVAL_CONFIG[interval],
      })),
      backfillRunning,
      binanceWeight: limiter.snapshot(),
      series: grouped
        .map((g) => ({
          symbol: g.symbol,
          interval: g.interval,
          bars: g._count._all,
          oldest: g._min.openTime,
          newest: g._max.openTime,
        }))
        .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.interval.localeCompare(b.interval)),
    }
  },
}
