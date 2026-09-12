/**
 * Trade Advisor — gives signals real authority over individual trades.
 *
 * Returns a structured, sourced advisory for a proposed trade so the
 * UI / live bot can either:
 *   - allow the trade (decision: 'ok')
 *   - allow with reduced size (decision: 'caution', recommendedSizeUsdt < requested)
 *   - block the trade entirely (decision: 'block', allow: false)
 *
 * Each reason carries a citation (source + URL) so traders can verify
 * exactly which feed / rule triggered the warning.
 */
import { prisma } from '@cryptoflow/db'
import { computeEnhancedSignalSnapshot, type EnhancedSignalSnapshot } from './providersHub'
import { env } from '../../lib/env'

export type AdvisorySeverity = 'info' | 'warning' | 'block'

export type AdvisoryReason = {
  code: string
  severity: AdvisorySeverity
  message: string
  source: string
  sourceUrl?: string
}

export type AdvisoryDecision = 'ok' | 'caution' | 'block'

export type TradeAdvisory = {
  symbol: string
  side: 'BUY' | 'SELL'
  decision: AdvisoryDecision
  /** True when the trade may proceed (decision !== 'block'). */
  allow: boolean
  /** Highest severity reason found across all checks. */
  highestSeverity: AdvisorySeverity
  reasons: AdvisoryReason[]
  /** Worst-case projected loss in USDT for the requested size. */
  projectedWorstCaseLossUsdt: number | null
  /** Multiplier for adverse intraday move based on ATR / vol. */
  expectedAdverseMovePct: number | null
  /** Recommended (possibly reduced) size for this trade. */
  recommendedSizeUsdt: number
  /** Suggested cap as % of capital (0..1). */
  capitalCapPct: number
  /** If blocked, suggested cooldown before re-checking. */
  cooldownSecs: number
  evaluatedAt: string
  snapshot: EnhancedSignalSnapshot
}

export type TradeAdvisoryRequest = {
  userId: string
  symbol: string
  side: 'BUY' | 'SELL'
  /** USDT notional the trader is about to commit. */
  sizeUsdt: number
  /** Optional capital context for sizing. */
  accountEquityUsdt?: number | null
}

// Calibrated for the "AI-signal automation" use case the operator asked for.
// We want the advisor to BLOCK only in true emergencies, not on weak consensus
// drift. Most real-world signal inputs (TV, funding, news) have signal
// confidence well below 0.4 most of the time — blocking on those would mean
// the bot never trades.
const MIN_PROVIDERS_FOR_BUY = 2
// Only treat a SELL consensus as a hard block when the conviction is genuinely
// strong. Below this we downgrade to caution / info.
const STRONG_SELL_BLOCK_CONFIDENCE = 0.6
const STRONG_CONFIDENCE = 0.55
const SOFT_CONFIDENCE = 0.35
const VOLATILE_24H_PCT = 18
const HIGH_FUNDING_RATE = 0.0012 // ~0.12% per 8h funding window
const LOSING_STREAK_BLOCK = 5
const LOSING_STREAK_CAUTION = 3
const DEFAULT_CAP_PCT = 0.06 // 6% of capital ceiling for any single trade

function pickProvider<T extends { id: string }>(providers: T[], id: string): T | undefined {
  return providers.find((p) => p.id === id)
}

function safeAtrPct(snapshot: EnhancedSignalSnapshot): number | null {
  const tv = pickProvider(snapshot.providers, 'tradingview-style-ta')
  const features = (tv?.features ?? null) as { volatilityPct?: number } | null
  const v = features?.volatilityPct
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

async function getRecentLosingStreak(userId: string): Promise<number> {
  const trades = await prisma.trade.findMany({
    where: { userId, status: 'CLOSED', pnl: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 8,
    select: { pnl: true },
  })
  let streak = 0
  for (const t of trades) {
    const pnl = Number(t.pnl ?? 0)
    if (pnl < 0) streak += 1
    else break
  }
  return streak
}

function rollUpSeverity(reasons: AdvisoryReason[]): AdvisorySeverity {
  if (reasons.some((r) => r.severity === 'block')) return 'block'
  if (reasons.some((r) => r.severity === 'warning')) return 'warning'
  return 'info'
}

function decisionFromSeverity(s: AdvisorySeverity): AdvisoryDecision {
  if (s === 'block') return 'block'
  if (s === 'warning') return 'caution'
  return 'ok'
}

export async function evaluateTradeIntent(req: TradeAdvisoryRequest): Promise<TradeAdvisory> {
  const symbol = req.symbol.toUpperCase().replace('/', '')
  const side: 'BUY' | 'SELL' = req.side === 'SELL' ? 'SELL' : 'BUY'
  const reasons: AdvisoryReason[] = []
  const snapshot = await computeEnhancedSignalSnapshot(symbol)

  // ---- 1. Operator kill switch ----------------------------------
  if (!env.LIVE_AUTOMATION_ENABLED) {
    reasons.push({
      code: 'OPERATOR_MAINTENANCE',
      severity: 'block',
      source: 'CryptoFlow operator console',
      message:
        env.LIVE_AUTOMATION_MAINTENANCE_REASON ??
        'Live automation is paused by the operator. New buys are blocked.',
    })
  }

  // ---- 2. Provider quorum ---------------------------------------
  // Only worth surfacing when we have *zero* providers (true outage).
  // We no longer warn on partial coverage because external feeds are flaky
  // and the AI signal alone is acceptable for the operator's automation goal.
  if (snapshot.providerCount < MIN_PROVIDERS_FOR_BUY) {
    reasons.push({
      code: 'INSUFFICIENT_PROVIDERS',
      severity: snapshot.providerCount === 0 ? 'warning' : 'info',
      message: `Only ${snapshot.providerCount} signal provider(s) reporting. Falling back to AI consensus.`,
      source: 'CryptoFlow signal hub',
      sourceUrl: '/api/engine/signal/enhanced',
    })
  }

  // ---- 3. Consensus disagreement --------------------------------
  if (side === 'BUY') {
    if (snapshot.consensus.signal === 'SELL') {
      // Block only on a genuinely strong SELL consensus. A weak SELL drift
      // (e.g. 13% conviction) is not a reliable contrarian signal and would
      // otherwise stop AI-driven automation indefinitely.
      const strongSell = snapshot.consensus.confidence >= STRONG_SELL_BLOCK_CONFIDENCE
      const moderateSell = snapshot.consensus.confidence >= SOFT_CONFIDENCE
      reasons.push({
        code: 'CONSENSUS_SELL',
        severity: strongSell ? 'block' : moderateSell ? 'warning' : 'info',
        message: `Aggregated consensus is SELL with ${(
          snapshot.consensus.confidence * 100
        ).toFixed(1)}% conviction.${
          strongSell
            ? ' Buying now fights a strong trend — auto-trades blocked.'
            : moderateSell
            ? ' Use caution / smaller size.'
            : ' Conviction is weak — informational only.'
        }`,
        source: 'Multi-source consensus (TV / funding / breadth / news / FNG)',
        sourceUrl: '/api/engine/signal/enhanced',
      })
    } else if (snapshot.consensus.signal === 'HOLD' && snapshot.consensus.confidence < SOFT_CONFIDENCE) {
      reasons.push({
        code: 'LOW_CONFIDENCE',
        severity: 'info',
        message: `Consensus is HOLD at low confidence (${(
          snapshot.consensus.confidence * 100
        ).toFixed(1)}%). The AI signal is the primary driver here — informational only.`,
        source: 'Multi-source consensus',
        sourceUrl: '/api/engine/signal/enhanced',
      })
    } else if (snapshot.consensus.signal === 'BUY' && snapshot.consensus.confidence < SOFT_CONFIDENCE) {
      reasons.push({
        code: 'WEAK_BUY',
        severity: 'info',
        message: `BUY consensus exists with ${(
          snapshot.consensus.confidence * 100
        ).toFixed(1)}% conviction. Sizing held to a conservative slice.`,
        source: 'Multi-source consensus',
        sourceUrl: '/api/engine/signal/enhanced',
      })
    }
  } else {
    if (snapshot.consensus.signal === 'BUY' && snapshot.consensus.confidence >= STRONG_CONFIDENCE) {
      reasons.push({
        code: 'CONSENSUS_AGAINST_SELL',
        severity: 'warning',
        message: `Aggregated consensus is BUY with ${(
          snapshot.consensus.confidence * 100
        ).toFixed(1)}% conviction. Selling here may forfeit upside.`,
        source: 'Multi-source consensus',
        sourceUrl: '/api/engine/signal/enhanced',
      })
    }
  }

  // ---- 4. Extreme 24h volatility --------------------------------
  const change24h = snapshot.market.change24hPct
  if (change24h !== null && Math.abs(change24h) >= VOLATILE_24H_PCT) {
    reasons.push({
      code: 'EXTREME_VOLATILITY',
      severity: 'warning',
      message: `${symbol} moved ${change24h.toFixed(
        2,
      )}% in 24h. Reduce size or wait for stabilisation — slippage and reversals are likely.`,
      source: 'Binance 24h ticker',
      sourceUrl: 'https://api.binance.com/api/v3/ticker/24hr',
    })
  }

  // ---- 5. Futures funding bias (overheated longs) ---------------
  const funding = pickProvider(snapshot.providers, 'binance-futures-funding')
  const fundingRate = (funding?.features as { lastFundingRate?: number } | null)?.lastFundingRate
  if (
    side === 'BUY' &&
    typeof fundingRate === 'number' &&
    fundingRate >= HIGH_FUNDING_RATE
  ) {
    reasons.push({
      code: 'HIGH_FUNDING_LONGS',
      severity: 'warning',
      message: `Perpetual funding is ${(fundingRate * 100).toFixed(
        4,
      )}% — longs are paying premium and are crowded. Long entries here often get squeezed.`,
      source: 'Binance Futures premiumIndex',
      sourceUrl: 'https://fapi.binance.com/fapi/v1/premiumIndex',
    })
  }

  // ---- 6. News / Reddit sentiment hostile -----------------------
  const newsProvider = pickProvider(snapshot.providers, 'cryptoflow-news-sentiment')
  const newsScore =
    (newsProvider?.features as { averageSentiment?: number } | null)?.averageSentiment
  if (
    side === 'BUY' &&
    typeof newsScore === 'number' &&
    newsScore <= -0.3 &&
    (newsProvider?.confidence ?? 0) >= 0.4
  ) {
    reasons.push({
      code: 'NEGATIVE_NEWS',
      severity: 'warning',
      message: `News + Reddit sentiment averaging ${newsScore.toFixed(
        2,
      )} (bearish). Wait for sentiment to stabilise before adding longs.`,
      source: 'RSS news + Reddit sentiment ingest',
      sourceUrl: '/api/dashboard/summary',
    })
  }

  // ---- 7. Fear & Greed extremes ---------------------------------
  const fng = pickProvider(snapshot.providers, 'alternative-me-fng')
  const fngVal = (fng?.features as { value?: number } | null)?.value
  if (typeof fngVal === 'number') {
    if (side === 'BUY' && fngVal >= 80) {
      reasons.push({
        code: 'EXTREME_GREED',
        severity: 'warning',
        message: `Fear & Greed index is ${fngVal} (extreme greed). Risk of local top — reduce buy size.`,
        source: 'Alternative.me Fear & Greed',
        sourceUrl: 'https://api.alternative.me/fng/',
      })
    } else if (side === 'SELL' && fngVal <= 20) {
      reasons.push({
        code: 'EXTREME_FEAR',
        severity: 'info',
        message: `Fear & Greed index is ${fngVal} (extreme fear). Selling into capitulation often locks in losses.`,
        source: 'Alternative.me Fear & Greed',
        sourceUrl: 'https://api.alternative.me/fng/',
      })
    }
  }

  // ---- 8. Losing streak cooldown --------------------------------
  let cooldownSecs = 0
  try {
    const streak = await getRecentLosingStreak(req.userId)
    if (streak >= LOSING_STREAK_BLOCK) {
      cooldownSecs = 60 * 30
      reasons.push({
        code: 'LOSING_STREAK_BLOCK',
        severity: 'block',
        message: `${streak} consecutive losing trades — auto-trading is on cooldown for 30 minutes to protect capital.`,
        source: 'CryptoFlow trade history',
        sourceUrl: '/api/engine/logs',
      })
    } else if (streak >= LOSING_STREAK_CAUTION) {
      reasons.push({
        code: 'LOSING_STREAK',
        severity: 'warning',
        message: `${streak} consecutive losing trades — reducing size by 50%.`,
        source: 'CryptoFlow trade history',
        sourceUrl: '/api/engine/logs',
      })
    }
  } catch {
    // history lookup is best-effort
  }

  // ---- 9. Worst-case loss projection ----------------------------
  const atrPct = safeAtrPct(snapshot)
  // If ATR not available, fall back to half of |24h change|, floor 3%, ceiling 15%.
  const fallbackPct = Math.min(15, Math.max(3, change24h !== null ? Math.abs(change24h) / 2 : 5))
  const expectedAdverseMovePct = atrPct !== null ? Math.max(atrPct, 1.5) : fallbackPct
  const projectedWorstCaseLossUsdt =
    Number.isFinite(req.sizeUsdt) && req.sizeUsdt > 0
      ? +(req.sizeUsdt * (expectedAdverseMovePct / 100)).toFixed(2)
      : null

  if (projectedWorstCaseLossUsdt !== null && projectedWorstCaseLossUsdt >= req.sizeUsdt * 0.15) {
    reasons.push({
      code: 'HIGH_PROJECTED_LOSS',
      severity: projectedWorstCaseLossUsdt >= req.sizeUsdt * 0.25 ? 'warning' : 'info',
      message: `Worst-case 1d adverse move (~${expectedAdverseMovePct.toFixed(
        2,
      )}%) would risk ~$${projectedWorstCaseLossUsdt.toFixed(
        2,
      )} on this position. Tighten stop-loss or reduce size.`,
      source: 'Binance 1h klines (ATR-style range)',
      sourceUrl: 'https://api.binance.com/api/v3/klines',
    })
  }

  // ---- 10. Recommended size -------------------------------------
  const equity =
    typeof req.accountEquityUsdt === 'number' && req.accountEquityUsdt > 0
      ? req.accountEquityUsdt
      : null
  let recommendedSize = req.sizeUsdt
  let capitalCapPct = DEFAULT_CAP_PCT
  if (equity !== null) {
    capitalCapPct = Math.min(
      DEFAULT_CAP_PCT,
      snapshot.recommendation.capitalFraction || DEFAULT_CAP_PCT,
    )
    const recommendedFromConsensus = equity * capitalCapPct
    recommendedSize = Math.min(req.sizeUsdt, recommendedFromConsensus)
  }
  // Halve on losing streak warnings or extreme volatility
  if (
    reasons.some(
      (r) =>
        r.code === 'LOSING_STREAK' ||
        r.code === 'EXTREME_VOLATILITY' ||
        r.code === 'WEAK_BUY' ||
        r.code === 'HIGH_FUNDING_LONGS' ||
        r.code === 'NEGATIVE_NEWS',
    )
  ) {
    recommendedSize = recommendedSize * 0.5
  }
  recommendedSize = Math.max(0, +recommendedSize.toFixed(2))

  const highestSeverity = rollUpSeverity(reasons)
  const decision = decisionFromSeverity(highestSeverity)
  if (decision === 'block') recommendedSize = 0

  return {
    symbol,
    side,
    decision,
    allow: decision !== 'block',
    highestSeverity,
    reasons,
    projectedWorstCaseLossUsdt,
    expectedAdverseMovePct,
    recommendedSizeUsdt: recommendedSize,
    capitalCapPct,
    cooldownSecs,
    evaluatedAt: new Date().toISOString(),
    snapshot,
  }
}
