import { Router, Request, Response } from 'express'
import { asyncHandler } from '../middleware/asyncHandler'

const router = Router()

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'USDCUSDT']

/** CoinGecko ids aligned with SYMBOLS base assets (for market cap / volume cross-check). */
const CG_IDS = 'bitcoin,ethereum,solana,binancecoin,ripple,dogecoin,usd-coin'
const CG_MAP: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
  DOGE: 'dogecoin',
  USDC: 'usd-coin',
}

const SUPPORTED_INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w'])
const ALLOWED_SYMBOL_RE = /^[A-Z0-9]{4,32}$/

router.get(
  '/candles/:symbol',
  asyncHandler(async (req: Request, res: Response) => {
    const symbol = String(req.params.symbol ?? '').toUpperCase().replace('/', '')
    if (!ALLOWED_SYMBOL_RE.test(symbol)) {
      res.status(400).json({ error: 'Invalid symbol' })
      return
    }
    const interval = String(req.query.interval ?? '1m')
    if (!SUPPORTED_INTERVALS.has(interval)) {
      res.status(400).json({ error: 'Unsupported interval' })
      return
    }
    const limitRaw = parseInt(String(req.query.limit ?? '120'), 10)
    const limit = Math.min(500, Math.max(20, Number.isFinite(limitRaw) ? limitRaw : 120))
    try {
      const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
      const r = await fetch(url)
      if (!r.ok) {
        res.status(502).json({ error: 'Upstream Binance error', status: r.status })
        return
      }
      const raw = (await r.json()) as Array<Array<string | number>>
      if (!Array.isArray(raw)) {
        res.status(502).json({ error: 'Invalid Binance payload' })
        return
      }
      const candles = raw.map((row) => ({
        openTime: Number(row[0]),
        open: parseFloat(String(row[1])),
        high: parseFloat(String(row[2])),
        low: parseFloat(String(row[3])),
        close: parseFloat(String(row[4])),
        volume: parseFloat(String(row[5])),
        closeTime: Number(row[6]),
      }))
      res.json({
        symbol,
        interval,
        count: candles.length,
        updatedAt: new Date().toISOString(),
        candles,
      })
    } catch {
      res.status(503).json({ error: 'Binance unreachable' })
    }
  }),
)

type Binance24h = {
  symbol: string
  lastPrice: string
  priceChangePercent: string
  highPrice: string
  lowPrice: string
  quoteVolume: string
  volume: string
}

type CoinGeckoMarket = {
  id: string
  market_cap: number | null
  total_volume: number | null
}

function toCoinGeckoMarkets(payload: unknown): CoinGeckoMarket[] {
  if (!Array.isArray(payload)) return []
  return payload
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id : '',
      market_cap: typeof item.market_cap === 'number' ? item.market_cap : null,
      total_volume: typeof item.total_volume === 'number' ? item.total_volume : null,
    }))
    .filter((item) => item.id.length > 0)
}

router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const results = await Promise.all(
    SYMBOLS.map((symbol) =>
      fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`).then(
        (r) => r.json() as Promise<Binance24h>
      )
    )
  )

  const prices: Record<string, { price: string; priceChangePercent: string; highPrice: string; lowPrice: string }> = {}
  for (const data of results) {
    prices[data.symbol] = {
      price: data.lastPrice,
      priceChangePercent: data.priceChangePercent,
      highPrice: data.highPrice,
      lowPrice: data.lowPrice,
    }
  }

  res.json(prices)
}))

router.get('/overview', asyncHandler(async (_req: Request, res: Response) => {
  const [tickers, cgRaw, klines] = await Promise.all([
    Promise.all(
      SYMBOLS.map((symbol) =>
        fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`).then((r) => r.json() as Promise<Binance24h>)
      )
    ),
    fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${CG_IDS}&per_page=10&page=1&sparkline=false`)
      .then((r) => r.json() as Promise<unknown>)
      .then((payload) => toCoinGeckoMarkets(payload))
      .catch(() => [] as CoinGeckoMarket[]),
    Promise.all(
      SYMBOLS.map((symbol) =>
        fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=7`)
          .then((r) => r.json() as Promise<[string, string, string, string, string][]>)
          .then((rows) => rows.map((c) => Number(c[4])))
          .catch(() => [] as number[])
      )
    ),
  ])

  const cgById = new Map(cgRaw.map((c) => [c.id, c] as const))

  const rows = SYMBOLS.map((symbol, i) => {
    const t = tickers[i]
    const base = symbol.replace('USDT', '')
    const cgId = CG_MAP[base]
    const cg = cgId ? cgById.get(cgId) : undefined
    const spark = klines[i] ?? []
    return {
      rank: i + 1,
      symbol: base,
      pair: symbol,
      lastPrice: Number(t?.lastPrice ?? 0),
      changePercent24h: Number(t?.priceChangePercent ?? 0),
      volume24hBase: Number(t?.volume ?? 0),
      volume24hQuote: Number(t?.quoteVolume ?? 0),
      marketCapUsd: cg?.market_cap ?? null,
      sparkline7d: spark,
    }
  })

  res.json({ updatedAt: new Date().toISOString(), rows })
}))

export default router
