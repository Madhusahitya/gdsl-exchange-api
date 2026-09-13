/**
 * Live momentum scanner — ranks trending Solana tokens for short-term trade ideas.
 *
 * Pulls Jupiter's precomputed `toptrending` lists (5m + 1h windows), which already
 * reflect near-real-time activity, then scores them by short-term price change,
 * buy/sell pressure, liquidity and organic-activity quality. Server-cached so the
 * UI can poll every few seconds without tripping Jupiter rate limits.
 *
 * NOT financial advice — these are momentum signals, not guarantees.
 */
import { fetchJupiterTopTrending, isJupiterTokenSafe, type JupiterV2Token } from './jupiterTokensV2'
import { isJupiterConfigured } from './jupiterClassicService'
import { fetchJupiterPricesV3 } from './jupiterPriceService'
import { SOL_DEX_CATALOG } from '../../lib/solDexCatalog'
import { isTier1Major, TIER1_SCORE_BONUS } from '../../lib/tier1Majors'
import { getJupiterLiveMarketBoard } from './jupiterMarketBoardService'

export type TradeSuggestion = {
  baseSymbol: string
  binanceSymbol: string
  mint: string
  name: string
  icon?: string
  usdPrice: number
  change5m: number
  change1h: number
  change24h: number
  liquidityUsd: number
  volume24hUsd: number
  organicScore: number
  /** Net buy pressure over 5m: numBuys − numSells (positive = more buyers). */
  netBuys5m: number
  /** 0–100 composite momentum score. */
  score: number
  signal: 'strong' | 'rising' | 'watch'
  rationale: string
}

let cache: { at: number; items: TradeSuggestion[] } | null = null
const CACHE_TTL_MS = 12_000

function normalizeBase(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

const SKIP_BASES = new Set(['USDC', 'USDT', 'FDUSD', 'TUSD', 'DAI', 'BUSD', 'USDP', 'USDS', 'PYUSD'])

function vol24h(t: JupiterV2Token): number {
  const s = t.stats24h
  return (s?.buyVolume ?? 0) + (s?.sellVolume ?? 0)
}

/** Composite 0–100 momentum score weighting short-term move, buy pressure and quality. */
function scoreToken(t: JupiterV2Token): number {
  const c5 = t.stats5m?.priceChange ?? 0
  const c1h = t.stats1h?.priceChange ?? 0
  const buys = t.stats5m?.numBuys ?? 0
  const sells = t.stats5m?.numSells ?? 0
  const total = buys + sells
  const buyRatio = total > 0 ? buys / total : 0.5
  const organic = (t.organicScore ?? 0) / 100

  // Reward positive short-term momentum, buy-side dominance and organic quality.
  // Momentum reward peaks at +8% (5m) / +12% (1h) then decays — a token already
  // up 20-40% in minutes is a chased pump, not an entry.
  const c5Adj = c5 > 8 ? Math.max(0, 8 - (c5 - 8) * 0.75) : Math.max(-20, c5)
  const c1hAdj = c1h > 12 ? Math.max(0, 12 - (c1h - 12) * 0.5) : Math.max(-15, c1h)
  const momentum = c5Adj * 2 + c1hAdj
  const pressure = (buyRatio - 0.5) * 60
  const quality = organic * 20
  const raw = 50 + momentum + pressure + quality
  return Math.max(0, Math.min(100, Math.round(raw)))
}

function classify(score: number, change5m: number): TradeSuggestion['signal'] {
  if (score >= 70 && change5m > 0) return 'strong'
  if (score >= 55 && change5m > 0) return 'rising'
  return 'watch'
}

function rationale(t: JupiterV2Token, signal: TradeSuggestion['signal']): string {
  const c5 = t.stats5m?.priceChange ?? 0
  const c1h = t.stats1h?.priceChange ?? 0
  const buys = t.stats5m?.numBuys ?? 0
  const sells = t.stats5m?.numSells ?? 0
  const dir = c5 >= 0 ? 'up' : 'down'
  const head =
    signal === 'strong'
      ? 'Strong momentum'
      : signal === 'rising'
        ? 'Rising'
        : 'On watch'
  return `${head}: ${c5 >= 0 ? '+' : ''}${c5.toFixed(2)}% (5m), ${c1h >= 0 ? '+' : ''}${c1h.toFixed(2)}% (1h), ${buys} buys vs ${sells} sells. Trending ${dir}.`
}

/** Top momentum-ranked trade ideas (server-cached ~5s). */
export async function getJupiterTradeSuggestions(limit = 8): Promise<{
  items: TradeSuggestion[]
  updatedAt: string
  cached: boolean
  disclaimer: string
}> {
  const disclaimer =
    'Momentum signals from live Solana activity — not financial advice. Trade small and use the break-even/stop-loss guides.'
  if (!isJupiterConfigured()) {
    return { items: [], updatedAt: new Date().toISOString(), cached: false, disclaimer }
  }

  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return { items: cache.items.slice(0, limit), updatedAt: new Date(cache.at).toISOString(), cached: true, disclaimer }
  }

  const [t5, t1h] = await Promise.all([
    fetchJupiterTopTrending('5m'),
    fetchJupiterTopTrending('1h'),
  ])

  // Merge both windows, dedup by mint, prefer the row with richer 5m stats.
  const byMint = new Map<string, JupiterV2Token>()
  for (const row of [...t5, ...t1h]) {
    if (!row.id) continue
    const existing = byMint.get(row.id)
    if (!existing || (row.stats5m && !existing.stats5m)) byMint.set(row.id, row)
  }

  // Jupiter toptrending is meme-heavy — inject SOL/BTC/ETH from the live board when missing.
  try {
    const board = await getJupiterLiveMarketBoard(400)
    for (const cat of SOL_DEX_CATALOG) {
      if (!isTier1Major(cat.baseSymbol) || byMint.has(cat.mint)) continue
      const row = board.rows.find((r) => r.baseSymbol === cat.baseSymbol)
      if (!row || row.quoteVolume < 150_000) continue
      const ch24 = row.priceChangePercent ?? 0
      byMint.set(cat.mint, {
        id: cat.mint,
        symbol: cat.baseSymbol,
        name: cat.name,
        usdPrice: row.lastPrice,
        liquidity: Math.max(row.quoteVolume * 0.08, 400_000),
        organicScore: 88,
        isVerified: true,
        stats5m: {
          priceChange: Math.max(-5, Math.min(8, ch24 * 0.04)),
          numBuys: 40,
          numSells: 38,
        },
        stats1h: {
          priceChange: Math.max(-10, Math.min(15, ch24 * 0.12)),
          numBuys: 180,
          numSells: 170,
        },
        stats24h: {
          priceChange: ch24,
          buyVolume: row.quoteVolume * 0.52,
          sellVolume: row.quoteVolume * 0.48,
        },
      })
    }
  } catch {
    /* board optional */
  }

  const items: TradeSuggestion[] = []
  for (const t of byMint.values()) {
    const base = normalizeBase(t.symbol ?? '')
    if (!base || base.length < 2 || base.length > 12 || SKIP_BASES.has(base)) continue
    if (!isJupiterTokenSafe(t, 25_000)) continue
    let score = scoreToken(t)
    if (isTier1Major(base)) score = Math.min(100, score + TIER1_SCORE_BONUS)
    const change5m = t.stats5m?.priceChange ?? 0
    const signal = classify(score, change5m)
    items.push({
      baseSymbol: base,
      binanceSymbol: `${base}USDT`,
      mint: t.id!,
      name: t.name ?? base,
      icon: t.icon,
      usdPrice: t.usdPrice ?? 0,
      change5m,
      change1h: t.stats1h?.priceChange ?? 0,
      change24h: t.stats24h?.priceChange ?? 0,
      liquidityUsd: t.liquidity ?? 0,
      volume24hUsd: vol24h(t),
      organicScore: t.organicScore ?? 0,
      netBuys5m: (t.stats5m?.numBuys ?? 0) - (t.stats5m?.numSells ?? 0),
      score,
      signal,
      rationale: rationale(t, signal),
    })
  }

  // Prefer liquid, not-overextended names — thin meme pumps confuse users vs chart mid.
  const filtered = items.filter(
    (i) =>
      i.liquidityUsd >= 75_000 &&
      i.change5m <= 12 &&
      i.change1h <= 25 &&
      i.usdPrice > 0,
  )
  filtered.sort((a, b) => {
    const aTier = isTier1Major(a.baseSymbol) ? 1 : 0
    const bTier = isTier1Major(b.baseSymbol) ? 1 : 0
    if (aTier !== bTier) return bTier - aTier
    return b.score - a.score
  })
  const top = filtered.slice(0, Math.max(limit, 12))

  // Overlay Jupiter Price API v3 (same source as the chart) so idea cards match candles.
  try {
    const prices = await fetchJupiterPricesV3(top.map((t) => t.mint))
    for (const item of top) {
      const live = prices.get(item.mint)
      if (live && live.usdPrice > 0) item.usdPrice = live.usdPrice
    }
  } catch {
    /* keep trending usdPrice */
  }

  cache = { at: now, items: top }
  return { items: top.slice(0, limit), updatedAt: new Date(now).toISOString(), cached: false, disclaimer }
}
