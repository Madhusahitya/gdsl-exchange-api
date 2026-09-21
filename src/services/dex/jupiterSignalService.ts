/**
 * Live trade signals for DEX Jupiter — ranks tradable tokens by real-time
 * momentum + liquidity using the (already cached) Jupiter market board.
 *
 * It keeps a short in-memory price history per symbol so it can measure
 * "rising right now" momentum without making any extra API calls. Signals are
 * momentum heuristics, NOT guaranteed profit — the UI must say so.
 */
import { getJupiterLiveMarketBoard } from './jupiterMarketBoardService'

export type JupiterTradeSignal = {
  symbol: string
  baseSymbol: string
  mint: string
  price: number
  /** % move since the previous snapshot (~7s). */
  instantPct: number
  /** % move over the recent short window (~60s). */
  shortPct: number
  /** 24h change for trend context. */
  trend24hPct: number
  quoteVolume: number
  score: number
  action: 'BUY' | 'WATCH'
  rationale: string
}

type Sample = { ts: number; price: number }
const history = new Map<string, Sample[]>()
const HISTORY_WINDOW_MS = 3 * 60_000
const SHORT_WINDOW_MS = 75_000
const MIN_QUOTE_VOLUME = 150_000
const STABLES = new Set(['USDC', 'USDT', 'FDUSD', 'TUSD', 'DAI', 'BUSD', 'USDP', 'USD1'])

function pushSample(symbol: string, price: number, now: number): Sample[] {
  const arr = history.get(symbol) ?? []
  arr.push({ ts: now, price })
  const trimmed = arr.filter((s) => now - s.ts <= HISTORY_WINDOW_MS)
  history.set(symbol, trimmed)
  return trimmed
}

function pctChange(from: number, to: number): number {
  if (from <= 0) return 0
  return ((to - from) / from) * 100
}

export async function getJupiterTradeSignals(limit = 6): Promise<{
  signals: JupiterTradeSignal[]
  updatedAt: string
  warmingUp: boolean
}> {
  const board = await getJupiterLiveMarketBoard(2000)
  const now = Date.now()
  let haveHistory = false

  const scored: JupiterTradeSignal[] = []
  for (const row of board.rows) {
    if (row.quoteVolume < MIN_QUOTE_VOLUME) continue
    if (STABLES.has(row.baseSymbol)) continue
    const price = row.lastPrice
    if (!Number.isFinite(price) || price <= 0) continue

    const samples = pushSample(row.symbol, price, now)
    const prev = samples.length >= 2 ? samples[samples.length - 2] : null
    const shortAnchor = [...samples].find((s) => now - s.ts >= SHORT_WINDOW_MS - 15_000) ?? samples[0]
    if (samples.length >= 2) haveHistory = true

    const instantPct = prev ? pctChange(prev.price, price) : 0
    const shortPct = shortAnchor ? pctChange(shortAnchor.price, price) : 0
    const trend24hPct = row.priceChangePercent ?? 0
    const liquidity = Math.log10(Math.max(10, row.quoteVolume))

    // Momentum-now dominates; short window confirms; 24h trend + liquidity are tie-breakers.
    const score = instantPct * 4 + shortPct * 2.5 + trend24hPct * 0.1 + liquidity

    const rising = shortPct > 0.1 && instantPct >= 0
    const action: JupiterTradeSignal['action'] = rising && trend24hPct > 0 ? 'BUY' : 'WATCH'

    const volTxt =
      row.quoteVolume >= 1e9
        ? `$${(row.quoteVolume / 1e9).toFixed(1)}B`
        : row.quoteVolume >= 1e6
          ? `$${(row.quoteVolume / 1e6).toFixed(0)}M`
          : `$${(row.quoteVolume / 1e3).toFixed(0)}K`
    const rationale =
      action === 'BUY'
        ? `Rising ${shortPct >= 0 ? '+' : ''}${shortPct.toFixed(2)}% (~60s) · 24h ${trend24hPct >= 0 ? '+' : ''}${trend24hPct.toFixed(1)}% · vol ${volTxt}`
        : `24h ${trend24hPct >= 0 ? '+' : ''}${trend24hPct.toFixed(1)}% · ${shortPct >= 0 ? 'flat/up' : 'cooling'} now · vol ${volTxt}`

    scored.push({
      symbol: row.symbol,
      baseSymbol: row.baseSymbol,
      mint: row.mint,
      price,
      instantPct: Math.round(instantPct * 100) / 100,
      shortPct: Math.round(shortPct * 100) / 100,
      trend24hPct: Math.round(trend24hPct * 100) / 100,
      quoteVolume: row.quoteVolume,
      score: Math.round(score * 100) / 100,
      action,
      rationale,
    })
  }

  scored.sort((a, b) => b.score - a.score)
  return {
    signals: scored.slice(0, Math.min(20, Math.max(1, limit))),
    updatedAt: new Date(now).toISOString(),
    warmingUp: !haveHistory,
  }
}
