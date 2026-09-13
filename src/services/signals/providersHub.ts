/**
 * Enhanced multi-provider signal hub.
 *
 * Aggregates many high-signal public data sources into a unified
 * provider list with explicit confidence scoring, rationale, and
 * recommended position sizing. Designed for production / real funds.
 *
 * Providers:
 *  - TradingView-style technical consensus (RSI, EMA cross, MACD, Bollinger, volume)
 *  - Binance 24h momentum (price change + volume vs market)
 *  - Binance Futures funding bias (premium index + top trader long/short)
 *  - Alternative.me Fear & Greed
 *  - CoinGecko BTC dominance regime
 *  - News/Reddit sentiment from NewsEvent table
 */
import { prisma } from '@cryptoflow/db'
import { ema, rsi, macd, bollinger, last } from '../market/indicators'
import { fetchFearGreed, fetchCoinGeckoGlobal } from '../freeMarketApis'

export type SignalDirection = 'BUY' | 'SELL' | 'HOLD'

export type SignalProvider = {
  id: string
  name: string
  sourceUrl: string
  signal: SignalDirection
  confidence: number
  note?: string
  features?: Record<string, unknown> | null
  weight?: number
}

export type SignalRecommendation = {
  action: SignalDirection
  sizingPct: number
  sizingLabel: 'avoid' | 'small' | 'moderate' | 'aggressive'
  rationale: string[]
  riskNotes: string[]
  invest: 'yes' | 'wait' | 'no'
  /** Suggested capital fraction (0..1). Caller multiplies by user capital. */
  capitalFraction: number
}

export type EnhancedSignalSnapshot = {
  symbol: string
  updatedAt: string
  providerCount: number
  consensus: {
    signal: SignalDirection
    confidence: number
    counts: { buy: number; sell: number; hold: number }
  }
  providers: SignalProvider[]
  recommendation: SignalRecommendation
  market: {
    lastPrice: number | null
    change24hPct: number | null
    volume24hUsd: number | null
    high24h: number | null
    low24h: number | null
  }
}

const TV_BINANCE_INTERVAL = '1h'
const TV_KLINE_LIMIT = 200

const BINANCE_REST = 'https://api.binance.com'
const BINANCE_FAPI = 'https://fapi.binance.com'

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}

function safeNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = parseFloat(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

type Kline = {
  openTime: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

async function fetchKlines(symbol: string): Promise<Kline[]> {
  try {
    const url = `${BINANCE_REST}/api/v3/klines?symbol=${symbol}&interval=${TV_BINANCE_INTERVAL}&limit=${TV_KLINE_LIMIT}`
    const r = await fetch(url)
    if (!r.ok) return []
    const j = (await r.json()) as Array<Array<string | number>>
    if (!Array.isArray(j)) return []
    return j.map((row) => ({
      openTime: Number(row[0]),
      open: parseFloat(String(row[1])),
      high: parseFloat(String(row[2])),
      low: parseFloat(String(row[3])),
      close: parseFloat(String(row[4])),
      volume: parseFloat(String(row[5])),
    }))
  } catch {
    return []
  }
}

async function fetchTicker24h(symbol: string): Promise<{
  lastPrice: number | null
  change24hPct: number | null
  volume24hUsd: number | null
  high24h: number | null
  low24h: number | null
} | null> {
  try {
    const r = await fetch(`${BINANCE_REST}/api/v3/ticker/24hr?symbol=${symbol}`)
    if (!r.ok) return null
    const j = (await r.json()) as Record<string, unknown>
    return {
      lastPrice: safeNumber(j.lastPrice),
      change24hPct: safeNumber(j.priceChangePercent),
      volume24hUsd: safeNumber(j.quoteVolume),
      high24h: safeNumber(j.highPrice),
      low24h: safeNumber(j.lowPrice),
    }
  } catch {
    return null
  }
}

async function fetchPremiumIndex(symbol: string): Promise<{
  markPrice: number | null
  lastFundingRate: number | null
  nextFundingTime: number | null
} | null> {
  try {
    const r = await fetch(`${BINANCE_FAPI}/fapi/v1/premiumIndex?symbol=${symbol}`)
    if (!r.ok) return null
    const j = (await r.json()) as Record<string, unknown>
    return {
      markPrice: safeNumber(j.markPrice),
      lastFundingRate: safeNumber(j.lastFundingRate),
      nextFundingTime: safeNumber(j.nextFundingTime),
    }
  } catch {
    return null
  }
}

async function fetchTopTraderRatio(symbol: string): Promise<{
  longShortRatio: number | null
} | null> {
  try {
    const url = `${BINANCE_FAPI}/futures/data/topLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`
    const r = await fetch(url)
    if (!r.ok) return null
    const j = (await r.json()) as Array<Record<string, unknown>>
    const row = Array.isArray(j) ? j[0] : null
    if (!row) return null
    return { longShortRatio: safeNumber(row.longShortRatio) }
  } catch {
    return null
  }
}

async function fetchMarketBreadth(): Promise<{
  upRatio: number | null
  totalSymbols: number
} | null> {
  try {
    const r = await fetch(`${BINANCE_REST}/api/v3/ticker/24hr`)
    if (!r.ok) return null
    const j = (await r.json()) as Array<Record<string, unknown>>
    if (!Array.isArray(j)) return null
    const usdt = j.filter((row) => typeof row.symbol === 'string' && (row.symbol as string).endsWith('USDT'))
    const totals = usdt.length || 0
    if (totals === 0) return null
    let up = 0
    for (const row of usdt) {
      const pct = safeNumber(row.priceChangePercent)
      if (pct !== null && pct > 0) up += 1
    }
    return { upRatio: up / totals, totalSymbols: totals }
  } catch {
    return null
  }
}

/* ----------------------------------------------------------------- */
/* Providers                                                          */
/* ----------------------------------------------------------------- */

function tradingViewLikeProvider(symbol: string, klines: Kline[]): SignalProvider | null {
  if (klines.length < 60) return null
  const closes = klines.map((k) => k.close)
  const highs = klines.map((k) => k.high)
  const lows = klines.map((k) => k.low)
  const vols = klines.map((k) => k.volume)

  const ema20 = last(ema(closes, 20))
  const ema50 = last(ema(closes, 50))
  const ema200 = last(ema(closes, 200))
  const rsi14 = last(rsi(closes, 14))
  const macdSet = macd(closes)
  const macdHist = last(macdSet.hist)
  const macdHistPrev = macdSet.hist[macdSet.hist.length - 2]
  const bb = bollinger(closes, 20, 2)
  const bbUpper = last(bb.upper)
  const bbLower = last(bb.lower)
  const lastClose = closes[closes.length - 1]

  let buyVotes = 0
  let sellVotes = 0
  let neutralVotes = 0
  const indicatorBreakdown: Record<string, 'BUY' | 'SELL' | 'NEUTRAL'> = {}

  if (Number.isFinite(ema20) && Number.isFinite(ema50)) {
    if (ema20 > ema50 * 1.0015) {
      buyVotes++
      indicatorBreakdown.emaCross = 'BUY'
    } else if (ema20 < ema50 * 0.9985) {
      sellVotes++
      indicatorBreakdown.emaCross = 'SELL'
    } else {
      neutralVotes++
      indicatorBreakdown.emaCross = 'NEUTRAL'
    }
  }

  if (Number.isFinite(ema200) && Number.isFinite(lastClose)) {
    if (lastClose > ema200) {
      buyVotes++
      indicatorBreakdown.trendEma200 = 'BUY'
    } else {
      sellVotes++
      indicatorBreakdown.trendEma200 = 'SELL'
    }
  }

  if (Number.isFinite(rsi14)) {
    if (rsi14 < 35) {
      buyVotes++
      indicatorBreakdown.rsi = 'BUY'
    } else if (rsi14 > 70) {
      sellVotes++
      indicatorBreakdown.rsi = 'SELL'
    } else {
      neutralVotes++
      indicatorBreakdown.rsi = 'NEUTRAL'
    }
  }

  if (Number.isFinite(macdHist) && Number.isFinite(macdHistPrev)) {
    const expanding = Math.abs(macdHist) > Math.abs(macdHistPrev)
    if (macdHist > 0 && expanding) {
      buyVotes++
      indicatorBreakdown.macd = 'BUY'
    } else if (macdHist < 0 && expanding) {
      sellVotes++
      indicatorBreakdown.macd = 'SELL'
    } else {
      neutralVotes++
      indicatorBreakdown.macd = 'NEUTRAL'
    }
  }

  if (Number.isFinite(bbUpper) && Number.isFinite(bbLower) && bbUpper > bbLower) {
    const range = bbUpper - bbLower
    const pos = (lastClose - bbLower) / range
    if (pos < 0.1) {
      buyVotes++
      indicatorBreakdown.bollinger = 'BUY'
    } else if (pos > 0.9) {
      sellVotes++
      indicatorBreakdown.bollinger = 'SELL'
    } else {
      neutralVotes++
      indicatorBreakdown.bollinger = 'NEUTRAL'
    }
  }

  // Volume momentum
  if (vols.length >= 20) {
    const recent = vols.slice(-5).reduce((a, b) => a + b, 0) / 5
    const baseline = vols.slice(-20, -5).reduce((a, b) => a + b, 0) / 15
    const ratio = baseline > 0 ? recent / baseline : 1
    const slope =
      closes[closes.length - 1] - closes[closes.length - 5]
    if (ratio > 1.4 && slope > 0) {
      buyVotes++
      indicatorBreakdown.volume = 'BUY'
    } else if (ratio > 1.4 && slope < 0) {
      sellVotes++
      indicatorBreakdown.volume = 'SELL'
    } else {
      neutralVotes++
      indicatorBreakdown.volume = 'NEUTRAL'
    }
  }

  const totalVotes = buyVotes + sellVotes + neutralVotes
  if (totalVotes === 0) return null

  let direction: SignalDirection = 'HOLD'
  if (buyVotes > sellVotes && buyVotes >= 3) direction = 'BUY'
  else if (sellVotes > buyVotes && sellVotes >= 3) direction = 'SELL'
  const confidence = clamp01(Math.max(buyVotes, sellVotes) / totalVotes)

  // Use ATR-like volatility proxy for quality
  const last20 = highs.slice(-20).map((h, i) => h - lows.slice(-20)[i])
  const avgRange = last20.reduce((a, b) => a + b, 0) / Math.max(1, last20.length)
  const volatilityPct = lastClose > 0 ? (avgRange / lastClose) * 100 : null

  return {
    id: 'tradingview-style-ta',
    name: 'TradingView-style technical consensus (RSI, EMA, MACD, BB, volume)',
    sourceUrl: `${BINANCE_REST}/api/v3/klines`,
    signal: direction,
    confidence,
    note: `${buyVotes} buy / ${sellVotes} sell / ${neutralVotes} neutral votes (1h)`,
    features: {
      symbol,
      interval: TV_BINANCE_INTERVAL,
      ema20,
      ema50,
      ema200,
      rsi14,
      macdHist,
      lastClose,
      indicatorBreakdown,
      volatilityPct,
    },
    weight: 1.6,
  }
}

function momentum24hProvider(
  symbol: string,
  ticker: Awaited<ReturnType<typeof fetchTicker24h>>,
): SignalProvider | null {
  if (!ticker || ticker.change24hPct === null) return null
  const change = ticker.change24hPct
  let signal: SignalDirection = 'HOLD'
  if (change > 1.5) signal = 'BUY'
  else if (change < -1.5) signal = 'SELL'
  const confidence = clamp01(Math.min(Math.abs(change) / 8, 1))
  return {
    id: 'binance-24h-momentum',
    name: '24h price momentum (Binance)',
    sourceUrl: `${BINANCE_REST}/api/v3/ticker/24hr`,
    signal,
    confidence,
    note: `${change.toFixed(2)}% over last 24h`,
    features: {
      symbol,
      change24hPct: change,
      lastPrice: ticker.lastPrice,
      volume24hUsd: ticker.volume24hUsd,
    },
    weight: 0.9,
  }
}

function fundingBiasProvider(
  symbol: string,
  premium: Awaited<ReturnType<typeof fetchPremiumIndex>>,
): SignalProvider | null {
  if (!premium || premium.lastFundingRate === null) return null
  const rate = premium.lastFundingRate
  let signal: SignalDirection = 'HOLD'
  if (rate < -0.0003) signal = 'BUY'
  else if (rate > 0.0008) signal = 'SELL'
  const confidence = clamp01(Math.min(Math.abs(rate) / 0.001, 1))
  return {
    id: 'binance-futures-funding',
    name: 'Futures funding bias (Binance perpetuals)',
    sourceUrl: `${BINANCE_FAPI}/fapi/v1/premiumIndex`,
    signal,
    confidence,
    note: `Funding rate ${(rate * 100).toFixed(4)}%`,
    features: {
      symbol,
      lastFundingRate: rate,
      markPrice: premium.markPrice,
    },
    weight: 0.7,
  }
}

function topTraderProvider(
  symbol: string,
  ratio: Awaited<ReturnType<typeof fetchTopTraderRatio>>,
): SignalProvider | null {
  if (!ratio || ratio.longShortRatio === null) return null
  const v = ratio.longShortRatio
  let signal: SignalDirection = 'HOLD'
  // Contrarian: extreme long crowding tends to fade.
  if (v >= 2.4) signal = 'SELL'
  else if (v <= 0.6) signal = 'BUY'
  const confidence = clamp01(Math.min(Math.abs(v - 1) / 1.5, 1))
  return {
    id: 'binance-futures-top-trader-ratio',
    name: 'Top trader long/short ratio (contrarian)',
    sourceUrl: `${BINANCE_FAPI}/futures/data/topLongShortAccountRatio`,
    signal,
    confidence,
    note: `Long/short ratio ${v.toFixed(2)}`,
    features: { symbol, longShortRatio: v },
    weight: 0.6,
  }
}

function fearGreedProvider(
  fg: Awaited<ReturnType<typeof fetchFearGreed>>,
): SignalProvider | null {
  if (!fg) return null
  let signal: SignalDirection = 'HOLD'
  if (fg.value <= 30) signal = 'BUY'
  else if (fg.value >= 75) signal = 'SELL'
  const confidence = clamp01(Math.abs(fg.value - 50) / 50)
  return {
    id: 'alternative-me-fng',
    name: 'Alternative.me Fear & Greed Index',
    sourceUrl: 'https://api.alternative.me/fng/',
    signal,
    confidence,
    note: fg.classification,
    features: { value: fg.value, classification: fg.classification },
    weight: 0.6,
  }
}

function btcDominanceProvider(
  cg: Awaited<ReturnType<typeof fetchCoinGeckoGlobal>>,
  symbol: string,
): SignalProvider | null {
  if (!cg || cg.btcDominancePct === null) return null
  const dom = cg.btcDominancePct
  const isAlt = !symbol.startsWith('BTC')
  let signal: SignalDirection = 'HOLD'
  if (isAlt) {
    if (dom < 50) signal = 'BUY'
    else if (dom > 58) signal = 'SELL'
  } else {
    if (dom > 55) signal = 'BUY'
    else if (dom < 48) signal = 'SELL'
  }
  const confidence = clamp01(Math.abs(dom - 52) / 10)
  return {
    id: 'coingecko-btc-dominance',
    name: 'BTC dominance regime (CoinGecko global)',
    sourceUrl: 'https://api.coingecko.com/api/v3/global',
    signal,
    confidence,
    note: `BTC dominance ${dom.toFixed(2)}%`,
    features: {
      btcDominancePct: dom,
      totalMarketCapUsd: cg.totalMarketCapUsd,
    },
    weight: 0.5,
  }
}

function marketBreadthProvider(
  breadth: Awaited<ReturnType<typeof fetchMarketBreadth>>,
): SignalProvider | null {
  if (!breadth || breadth.upRatio === null) return null
  const r = breadth.upRatio
  let signal: SignalDirection = 'HOLD'
  if (r >= 0.6) signal = 'BUY'
  else if (r <= 0.4) signal = 'SELL'
  const confidence = clamp01(Math.abs(r - 0.5) * 2)
  return {
    id: 'binance-market-breadth',
    name: 'USDT market breadth (Binance 24h)',
    sourceUrl: `${BINANCE_REST}/api/v3/ticker/24hr`,
    signal,
    confidence,
    note: `${(r * 100).toFixed(0)}% of USDT pairs up over 24h (${breadth.totalSymbols} symbols)`,
    features: { upRatio: r, totalSymbols: breadth.totalSymbols },
    weight: 0.5,
  }
}

async function newsSentimentProvider(symbol: string): Promise<SignalProvider | null> {
  try {
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000)
    const items = await prisma.newsEvent.findMany({
      where: { publishedAt: { gte: since } },
      orderBy: { publishedAt: 'desc' },
      take: 60,
      select: { source: true, title: true, sentimentScore: true, symbolsMentioned: true },
    })
    if (items.length === 0) return null
    const baseAsset = symbol.replace(/USDT|BUSD|FDUSD|USDC$/, '')
    const relevant = items.filter((it) => {
      if (!Array.isArray(it.symbolsMentioned)) return false
      return it.symbolsMentioned.some((m) => m.toUpperCase().includes(baseAsset.toUpperCase()))
    })
    const pool = relevant.length >= 3 ? relevant : items
    const score =
      pool.reduce((a, b) => a + Number(b.sentimentScore ?? 0), 0) / Math.max(1, pool.length)
    let signal: SignalDirection = 'HOLD'
    if (score > 0.15) signal = 'BUY'
    else if (score < -0.15) signal = 'SELL'
    const confidence = clamp01(Math.min(Math.abs(score) * 2, 1))
    return {
      id: 'cryptoflow-news-sentiment',
      name: 'News & Reddit sentiment (RSS + Reddit)',
      sourceUrl: '/api/dashboard/summary',
      signal,
      confidence,
      note: `${pool.length} headlines analysed (last 6h)`,
      features: {
        averageSentiment: score,
        totalAnalysed: pool.length,
        coinSpecific: relevant.length,
      },
      weight: 0.7,
    }
  } catch {
    return null
  }
}

/* ----------------------------------------------------------------- */
/* Aggregation                                                         */
/* ----------------------------------------------------------------- */

function consensusOf(providers: SignalProvider[]) {
  const weighted = { BUY: 0, SELL: 0, HOLD: 0 }
  const counts = { buy: 0, sell: 0, hold: 0 }
  let totalWeight = 0
  for (const p of providers) {
    const w = clamp01(p.confidence) * (p.weight ?? 1)
    weighted[p.signal] += w
    totalWeight += p.weight ?? 1
    if (p.signal === 'BUY') counts.buy += 1
    else if (p.signal === 'SELL') counts.sell += 1
    else counts.hold += 1
  }
  if (totalWeight === 0 || providers.length === 0) {
    return { signal: 'HOLD' as const, confidence: 0, counts }
  }
  const max = Math.max(weighted.BUY, weighted.SELL, weighted.HOLD)
  const winners = ([
    ['BUY', weighted.BUY],
    ['SELL', weighted.SELL],
    ['HOLD', weighted.HOLD],
  ] as const).filter(([, score]) => score === max)
  if (winners.length !== 1) {
    return { signal: 'HOLD' as const, confidence: clamp01(max / totalWeight), counts }
  }
  return {
    signal: winners[0][0] as SignalDirection,
    confidence: clamp01(max / totalWeight),
    counts,
  }
}

function recommendationFrom(
  providers: SignalProvider[],
  consensus: ReturnType<typeof consensusOf>,
  market: EnhancedSignalSnapshot['market'],
): SignalRecommendation {
  const rationale: string[] = []
  const riskNotes: string[] = []
  for (const p of providers) {
    rationale.push(`${p.name}: ${p.signal} (${Math.round(p.confidence * 100)}%)`)
  }

  // Confidence + provider quorum drive sizing.
  let sizingPct = 0
  let sizingLabel: SignalRecommendation['sizingLabel'] = 'avoid'
  let invest: SignalRecommendation['invest'] = 'wait'

  const conf = consensus.confidence
  const haveQuorum = providers.length >= 4

  if (consensus.signal === 'BUY' && haveQuorum) {
    if (conf >= 0.7) {
      sizingPct = 4
      sizingLabel = 'aggressive'
      invest = 'yes'
    } else if (conf >= 0.5) {
      sizingPct = 2.5
      sizingLabel = 'moderate'
      invest = 'yes'
    } else if (conf >= 0.35) {
      sizingPct = 1
      sizingLabel = 'small'
      invest = 'yes'
    } else {
      sizingPct = 0
      sizingLabel = 'avoid'
      invest = 'wait'
    }
  } else if (consensus.signal === 'SELL' && haveQuorum) {
    sizingPct = 0
    sizingLabel = 'avoid'
    invest = 'no'
    riskNotes.push('Consensus is SELL — exit existing longs and avoid new buys.')
  } else {
    sizingPct = 0
    sizingLabel = 'avoid'
    invest = 'wait'
    if (!haveQuorum) {
      riskNotes.push(
        `Only ${providers.length} of expected providers reporting — wait until at least 4 are online.`,
      )
    }
  }

  if (market.change24hPct !== null && Math.abs(market.change24hPct) > 12) {
    riskNotes.push(
      `24h move is ${market.change24hPct.toFixed(2)}% — extreme volatility, halve position size.`,
    )
    sizingPct = sizingPct * 0.5
    if (sizingLabel === 'aggressive') sizingLabel = 'moderate'
    else if (sizingLabel === 'moderate') sizingLabel = 'small'
  }

  return {
    action: consensus.signal,
    sizingPct,
    sizingLabel,
    rationale,
    riskNotes,
    invest,
    capitalFraction: sizingPct / 100,
  }
}

export async function computeEnhancedSignalSnapshot(symbol: string): Promise<EnhancedSignalSnapshot> {
  const [klines, ticker, premium, ratio, fg, breadth, cg] = await Promise.all([
    fetchKlines(symbol),
    fetchTicker24h(symbol),
    fetchPremiumIndex(symbol),
    fetchTopTraderRatio(symbol),
    fetchFearGreed(),
    fetchMarketBreadth(),
    fetchCoinGeckoGlobal(),
  ])

  const newsProvider = await newsSentimentProvider(symbol)

  const providers: SignalProvider[] = []
  const tv = tradingViewLikeProvider(symbol, klines)
  if (tv) providers.push(tv)
  const mom = momentum24hProvider(symbol, ticker)
  if (mom) providers.push(mom)
  const fund = fundingBiasProvider(symbol, premium)
  if (fund) providers.push(fund)
  const top = topTraderProvider(symbol, ratio)
  if (top) providers.push(top)
  const fgProv = fearGreedProvider(fg)
  if (fgProv) providers.push(fgProv)
  const breadthProv = marketBreadthProvider(breadth)
  if (breadthProv) providers.push(breadthProv)
  const dom = btcDominanceProvider(cg, symbol)
  if (dom) providers.push(dom)
  if (newsProvider) providers.push(newsProvider)

  const market = {
    lastPrice: ticker?.lastPrice ?? null,
    change24hPct: ticker?.change24hPct ?? null,
    volume24hUsd: ticker?.volume24hUsd ?? null,
    high24h: ticker?.high24h ?? null,
    low24h: ticker?.low24h ?? null,
  }
  const consensus = consensusOf(providers)
  const recommendation = recommendationFrom(providers, consensus, market)

  return {
    symbol,
    updatedAt: new Date().toISOString(),
    providerCount: providers.length,
    consensus,
    providers,
    recommendation,
    market,
  }
}

export async function computeMultiSymbolSnapshot(symbols: string[]): Promise<{
  updatedAt: string
  symbols: EnhancedSignalSnapshot[]
  topPicks: Array<{
    symbol: string
    score: number
    action: SignalDirection
    sizingLabel: SignalRecommendation['sizingLabel']
  }>
}> {
  const settled = await Promise.allSettled(symbols.map((s) => computeEnhancedSignalSnapshot(s)))
  const okSnapshots = settled
    .filter((r): r is PromiseFulfilledResult<EnhancedSignalSnapshot> => r.status === 'fulfilled')
    .map((r) => r.value)

  const ranked = okSnapshots
    .map((s) => {
      const directional = s.consensus.signal === 'BUY' ? 1 : s.consensus.signal === 'SELL' ? -1 : 0
      const score = directional * s.consensus.confidence * (s.recommendation.capitalFraction || 0.01)
      return {
        symbol: s.symbol,
        score,
        action: s.consensus.signal,
        sizingLabel: s.recommendation.sizingLabel,
      }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)

  return {
    updatedAt: new Date().toISOString(),
    symbols: okSnapshots,
    topPicks: ranked,
  }
}
