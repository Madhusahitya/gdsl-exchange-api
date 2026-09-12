/**
 * Turns a prediction market into a judgement the user can act on.
 *
 * For crypto strike markets we already hold the two things needed to price the
 * bet independently: the live price and how volatile the token has actually
 * been over the past year, both from the candle store. That gives a probability
 * to compare against the market's own, which is what an edge is. Anything we
 * cannot price this way is returned without a suggestion rather than with a
 * guess.
 */
import { logger } from '../../lib/logger'
import { getMarketContext } from '../market/marketContextService'
import { klineService } from '../market/klineService'
import {
  estimateProbability,
  impliedProbability,
  judgeEdge,
  parseCryptoClaim,
  stakeBreakdown,
  type CryptoClaim,
  type EdgeVerdict,
} from './predictionMath'
import type { JupiterPredictionEvent, JupiterPredictionMarket } from './jupiterPredictionService'

export type MarketInsight = {
  marketId: string
  /** The bet restated in one line, so the label is never just a bare strike. */
  plainQuestion: string
  /** Days until trading closes, when a close time is known. */
  daysToClose: number | null
  closeTime: string | null
  yes: { priceUsd: number | null; impliedProbPct: number | null }
  no: { priceUsd: number | null; impliedProbPct: number | null }
  /** What a default stake buys, for the "risk X to win Y" line. */
  stake: { usd: number; contracts: number; maxPayout: number; maxProfit: number } | null
  /** Present only for markets we can price ourselves. */
  model: {
    base: string
    spot: number
    strike: number
    direction: 'above' | 'below'
    isTouch: boolean
    annualizedVolPct: number
    ourProbYesPct: number
  } | null
  verdict: EdgeVerdict
  volumeUsd: number | null
  settled: boolean
  result: string | null
}

export type EventInsight = {
  eventId: string
  markets: MarketInsight[]
  /** Best actionable market in this event, if any. */
  topPick: { marketId: string; side: 'YES' | 'NO'; edgePct: number; evPerDollar: number } | null
}

const DEFAULT_STAKE_USD = 25

function daysUntil(iso: string | undefined): number | null {
  if (!iso) return null
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) return null
  return Math.max(0, (ms - Date.now()) / 86_400_000)
}

/** Restates the bet in one sentence so a bare "$100k" row becomes readable. */
function plainQuestion(
  eventTitle: string,
  marketTitle: string,
  claim: CryptoClaim | null,
  closeTime: string | undefined,
): string {
  if (claim) {
    const level = claim.strike.toLocaleString(undefined, { maximumFractionDigits: 8 })
    const verb = claim.isTouch
      ? claim.direction === 'above'
        ? `trade at or above $${level} at any point`
        : `fall to $${level} or lower at any point`
      : claim.direction === 'above'
        ? `be above $${level}`
        : `be below $${level}`
    const when = closeTime
      ? ` by ${new Date(closeTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
      : ''
    return `Will ${claim.base} ${verb}${when}?`
  }

  // Not a crypto strike: fall back to stitching the event question to the
  // outcome label, which is the context the old row was missing.
  const t = marketTitle.trim()
  const e = eventTitle.trim()
  if (!t || t.toLowerCase() === e.toLowerCase()) return e
  return `${e} — ${t}`
}

type AssetStats = { spot: number; annualizedVolPct: number } | null

/**
 * Per-request memo of asset lookups. The same base asset appears across many
 * markets in a page of events, and every market is priced in parallel, so
 * without this a cold cache would fire one full candle read per market rather
 * than one per asset.
 */
type StatsCache = Map<string, Promise<AssetStats>>

/** Live price and realised volatility for a base asset, from the candle store. */
async function assetStats(base: string): Promise<AssetStats> {
  const symbol = `${base}USDT`
  try {
    const ctx = await getMarketContext(symbol)
    const vol = ctx.longHorizon?.annualizedVolPct
    if (vol == null || !(vol > 0)) return null

    // Prefer the freshest close available across the stored timeframes.
    const spotFromCtx = ctx.timeframes.find((t) => t.close != null)?.close ?? null
    const spot =
      spotFromCtx ??
      (await klineService.getCandles(symbol, '1h', 1).then((c) => c.at(-1)?.close ?? null).catch(() => null))
    if (spot == null || !(spot > 0)) return null

    return { spot, annualizedVolPct: vol }
  } catch (err) {
    logger.debug({ err, base }, '[prediction-edge] asset stats unavailable')
    return null
  }
}

function cachedAssetStats(cache: StatsCache, base: string): Promise<AssetStats> {
  const hit = cache.get(base)
  if (hit) return hit
  const pending = assetStats(base)
  cache.set(base, pending)
  return pending
}

async function insightForMarket(
  event: JupiterPredictionEvent,
  market: JupiterPredictionMarket,
  stakeUsd: number,
  statsCache: StatsCache,
): Promise<MarketInsight> {
  const closeTime = market.metadata.closeTime ?? event.metadata.closeTime
  const days = daysUntil(closeTime)

  // The strike usually lives on the outcome label, but single-market events put
  // it in the event title instead, so try both.
  const claim = parseCryptoClaim(market.metadata.title) ?? parseCryptoClaim(event.metadata.title)

  const yesPrice = impliedProbability(market.pricing.buyYesPriceUsd)
  const noPrice = impliedProbability(market.pricing.buyNoPriceUsd)

  let model: MarketInsight['model'] = null
  let ourProbYes: number | null = null

  if (claim && event.category !== 'sports' && event.category !== 'politics') {
    const stats = await cachedAssetStats(statsCache, claim.base)
    if (stats) {
      const p = estimateProbability({
        spot: stats.spot,
        strike: claim.strike,
        direction: claim.direction,
        days: days ?? 30,
        annualizedVolPct: stats.annualizedVolPct,
        isTouch: claim.isTouch,
      })
      if (p != null) {
        ourProbYes = p
        model = {
          base: claim.base,
          spot: stats.spot,
          strike: claim.strike,
          direction: claim.direction,
          isTouch: claim.isTouch,
          annualizedVolPct: stats.annualizedVolPct,
          ourProbYesPct: p * 100,
        }
      }
    }
  }

  const volumeUsd = market.pricing.volume ?? (event.volumeUsd != null ? Number(event.volumeUsd) : null)
  const verdict = judgeEdge({
    yesPriceMicro: market.pricing.buyYesPriceUsd,
    noPriceMicro: market.pricing.buyNoPriceUsd,
    ourProbYes,
    volumeUsd,
    days,
  })

  const settled = market.result != null || /resolved|settled|closed/i.test(market.status)
  if (settled) {
    verdict.action = 'SKIP'
    verdict.cautions.unshift('This market has already settled.')
  }

  const chosenPrice = verdict.best?.price ?? yesPrice
  const breakdown = chosenPrice != null ? stakeBreakdown(stakeUsd, chosenPrice) : null

  return {
    marketId: market.marketId,
    plainQuestion: plainQuestion(event.metadata.title, market.metadata.title, claim, closeTime),
    daysToClose: days != null ? Math.round(days * 10) / 10 : null,
    closeTime: closeTime ?? null,
    yes: { priceUsd: yesPrice, impliedProbPct: yesPrice != null ? yesPrice * 100 : null },
    no: { priceUsd: noPrice, impliedProbPct: noPrice != null ? noPrice * 100 : null },
    stake: breakdown
      ? {
          usd: stakeUsd,
          contracts: breakdown.contracts,
          maxPayout: breakdown.maxPayout,
          maxProfit: breakdown.maxProfit,
        }
      : null,
    model,
    verdict,
    volumeUsd,
    settled,
    result: market.result,
  }
}

/**
 * Adds plain-language questions, probabilities and edge verdicts to a page of
 * events. Markets we cannot price ourselves still get the readable question and
 * payout maths, just no suggestion.
 */
export async function buildEventInsights(
  events: JupiterPredictionEvent[],
  stakeUsd = DEFAULT_STAKE_USD,
): Promise<EventInsight[]> {
  const stake = Number.isFinite(stakeUsd) && stakeUsd > 0 ? stakeUsd : DEFAULT_STAKE_USD
  const statsCache: StatsCache = new Map()

  return Promise.all(
    events.map(async (event) => {
      const markets = await Promise.all(
        (event.markets ?? []).map((m) => insightForMarket(event, m, stake, statsCache)),
      )

      const actionable = markets
        .filter((m) => m.verdict.action !== 'SKIP' && m.verdict.best != null)
        .sort((a, b) => b.verdict.best!.evPerDollar - a.verdict.best!.evPerDollar)

      const top = actionable[0]
      return {
        eventId: event.eventId,
        markets,
        topPick: top
          ? {
              marketId: top.marketId,
              side: top.verdict.best!.side,
              edgePct: top.verdict.best!.edgePct,
              evPerDollar: top.verdict.best!.evPerDollar,
            }
          : null,
      }
    }),
  )
}
