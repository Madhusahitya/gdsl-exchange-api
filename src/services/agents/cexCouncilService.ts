/**
 * AI Agent Council for Binance CEX Super Machine.
 *
 * Same specialist roles as Jupiter council (momentum / sentiment / technical /
 * risk / LLM) but candidates come from Binance spot majors + enhanced signal
 * hub — not Jupiter trending tokens. Jupiter council paths are untouched.
 */
import { ExecutionEventType, prisma } from '@cryptoflow/db'
import { logger } from '../../lib/logger'
import { getSocketIo } from '../../lib/realtimeHub'
import { computeEnhancedSignalSnapshot } from '../signals/providersHub'
import { fetchBookTicker } from '../trading/binanceSpotQuoteService'
import { orderBookService } from '../market/orderBook'
import { technicalVote, type AgentVote } from './technicalAgent'
import { summarizeContext } from '../market/marketContextService'
import { isLlmConfigured, llmStrategistVote, type LlmVote } from './llmStrategist'
import { agentBus } from './agentBus'
import {
  COUNCIL_AGENT_IDS,
  type CouncilAgentId,
  type CouncilDecision,
  type CouncilVotes,
  type AgentPerformance,
} from './councilService'

export type CexCouncilSettings = {
  maxTradeUsd: number
  watchSymbol: string
  hasOpenLong: boolean
}

const BASE_THRESHOLD = 0.62
const VETO_CONFIDENCE = 0.72
const MIN_BUY_VOTES = 3
const WIN_RATE_TARGET = { min: 65, max: 70 }

const AGENT_LABELS: Record<CouncilAgentId, string> = {
  momentum: 'Momentum Scanner',
  sentiment: 'Sentiment Oracle',
  technical: 'Technical Analyst',
  risk: 'Risk Manager',
  llm: 'LLM Strategist',
  orderbook: 'Order Book Flow',
  volatility: 'Volatility Regime',
}

const lastVotesByUser = new Map<string, CouncilVotes>()

const recentByUser = new Map<string, CouncilDecision[]>()

function genId(): string {
  return `cex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function voteScore(v: AgentVote): number {
  if (v.vote === 'BUY') return v.confidence
  if (v.vote === 'AVOID') return -v.confidence
  return 0
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

export async function cexCouncilEvaluate(opts: {
  userId: string
  settings: CexCouncilSettings
  freeUsdt: number
}): Promise<CouncilDecision> {
  const { userId, settings, freeUsdt } = opts
  const symbol = settings.watchSymbol.replace('/', '').toUpperCase()
  const base = symbol.replace(/USDT$/, '')

  const [snapshot, book, tech] = await Promise.all([
    computeEnhancedSignalSnapshot(symbol).catch(() => null),
    fetchBookTicker(symbol).catch(() => null),
    technicalVote(symbol),
  ])

  const price = book?.mid ?? snapshot?.market.lastPrice ?? null
  const conf = snapshot?.consensus.confidence ?? 0
  const consSignal = snapshot?.consensus.signal ?? 'HOLD'

  // Momentum from multi-provider enhanced hub (Binance 24h, funding, technicals…)
  const momentum: AgentVote =
    consSignal === 'BUY' && conf >= 0.45
      ? {
          vote: 'BUY',
          confidence: clamp(conf, 0.35, 0.9),
          reason: `CEX hub BUY · ${(conf * 100).toFixed(0)}% · ${snapshot?.recommendation.rationale[0] ?? 'multi-provider'}`,
        }
      : consSignal === 'SELL' && conf >= 0.45
        ? {
            vote: 'AVOID',
            confidence: clamp(conf, 0.4, 0.9),
            reason: `CEX hub SELL · ${(conf * 100).toFixed(0)}% — wait / exit bias`,
          }
        : {
            vote: 'HOLD',
            confidence: 0.45,
            reason: snapshot
              ? `CEX hub ${consSignal} · ${(conf * 100).toFixed(0)}% — not enough edge`
              : 'Signal hub unavailable',
          }

  const oracle = agentBus.getCached<{ sentimentScore: number; confidence: number; catalyst?: string }>(
    'sentiment:update',
    'oracle',
  )
  const sentiment: AgentVote = oracle
    ? oracle.sentimentScore < -0.35 && oracle.confidence > 0.4
      ? { vote: 'AVOID', confidence: Math.min(0.85, oracle.confidence + 0.15), reason: 'Risk-off news flow' }
      : oracle.sentimentScore > 0.25 && oracle.confidence > 0.35
        ? {
            vote: 'BUY',
            confidence: Math.min(0.8, 0.45 + oracle.sentimentScore * 0.4),
            reason: oracle.catalyst ?? 'Positive macro/news tone',
          }
        : { vote: 'HOLD', confidence: 0.4, reason: 'Neutral news flow' }
    : { vote: 'HOLD', confidence: 0.35, reason: 'No sentiment data yet' }

  let technical: AgentVote = tech
  if (tech.reason === 'Candle data unavailable') {
    technical = {
      vote: 'AVOID',
      confidence: 0.78,
      reason: 'No candle/price data — CEX entry blocked until feeds recover',
    }
  }

  const spreadBps =
    book?.bid != null && book?.ask != null && book.mid > 0
      ? ((book.ask - book.bid) / book.mid) * 10_000
      : null

  let riskVote: AgentVote
  if (settings.hasOpenLong) {
    riskVote = { vote: 'HOLD', confidence: 0.7, reason: 'Already in a CEX long — wait for TP/SL or exit' }
  } else if (freeUsdt < 5) {
    riskVote = { vote: 'AVOID', confidence: 0.85, reason: `Free USDT $${freeUsdt.toFixed(2)} below $5 minimum` }
  } else if (spreadBps != null && spreadBps > 15) {
    riskVote = {
      vote: 'AVOID',
      confidence: 0.75,
      reason: `Spread ${spreadBps.toFixed(1)} bps too wide for safe entry`,
    }
  } else if (snapshot?.recommendation.invest === 'no') {
    riskVote = {
      vote: 'AVOID',
      confidence: 0.7,
      reason: snapshot.recommendation.riskNotes[0] ?? 'Hub recommends no investment',
    }
  } else if (consSignal === 'BUY' && conf >= 0.5) {
    riskVote = {
      vote: 'BUY',
      confidence: clamp(0.5 + conf * 0.35, 0.45, 0.88),
      reason: `CEX risk OK · size cap $${settings.maxTradeUsd} · spread ${spreadBps?.toFixed(1) ?? '—'} bps`,
    }
  } else {
    riskVote = { vote: 'HOLD', confidence: 0.5, reason: 'Waiting for clearer CEX setup' }
  }

  let llm: LlmVote = {
    vote: 'HOLD',
    confidence: 0,
    reason: isLlmConfigured() ? 'Consulted only on live CEX candidates' : 'LLM offline',
    provider: null,
    latencyMs: null,
  }
  if (price != null && !settings.hasOpenLong && freeUsdt >= 5 && consSignal === 'BUY') {
    llm = await llmStrategistVote({
      symbol: base,
      priceUsd: price,
      change5mPct: 0,
      change1hPct: snapshot?.market.change24hPct != null ? snapshot.market.change24hPct / 24 : 0,
      change24hPct: snapshot?.market.change24hPct ?? 0,
      liquidityUsd: snapshot?.market.volume24hUsd ?? 1_000_000,
      volume24hUsd: snapshot?.market.volume24hUsd ?? 0,
      momentumScore: conf,
      rsi14: 'rsi14' in tech ? (tech as { rsi14: number | null }).rsi14 : null,
      emaCrossBull: 'emaCrossBull' in tech ? (tech as { emaCrossBull: boolean | null }).emaCrossBull : null,
      trendStrength: 'trendStrength' in tech ? (tech as { trendStrength: number }).trendStrength : 0.5,
      newsSentiment: oracle?.sentimentScore ?? null,
      solSpreadBps: spreadBps,
      orderBookImbalance: null,
      recentWinRatePct: null,
      marketContext: tech.context ? summarizeContext(tech.context) : null,
    })
  }

  const obi = orderBookService.getOBI(symbol)
  const orderbook: AgentVote =
    obi == null
      ? { vote: 'HOLD', confidence: 0.3, reason: 'Binance depth OBI warming up' }
      : obi > 0.15
        ? {
            vote: 'BUY',
            confidence: Math.min(0.85, 0.48 + obi * 0.55),
            reason: `Binance bid pressure · OBI ${obi.toFixed(2)}`,
          }
        : obi < -0.15
          ? {
              vote: 'AVOID',
              confidence: Math.min(0.85, 0.48 + Math.abs(obi) * 0.55),
              reason: `Binance ask pressure · OBI ${obi.toFixed(2)}`,
            }
          : { vote: 'HOLD', confidence: 0.4, reason: `Balanced Binance book · OBI ${obi.toFixed(2)}` }

  const change24 = snapshot?.market.change24hPct ?? 0
  const volatility: AgentVote =
    Math.abs(change24) >= 6
      ? {
          vote: 'AVOID',
          confidence: 0.72,
          reason: `Elevated 24h move ${change24.toFixed(1)}% — wait for calm`,
        }
      : consSignal === 'BUY' && Math.abs(change24) <= 3.5
        ? {
            vote: 'BUY',
            confidence: 0.58,
            reason: `Controlled vol · 24h ${change24.toFixed(1)}%`,
          }
        : {
            vote: 'HOLD',
            confidence: 0.42,
            reason: `Vol watch · 24h ${change24.toFixed(1)}%`,
          }

  const votes = {} as CouncilVotes
  const raw: Record<CouncilAgentId, AgentVote> = {
    momentum,
    sentiment,
    technical,
    risk: riskVote,
    llm,
    orderbook,
    volatility,
  }
  let weighted = 0
  let totalWeight = 0
  let vetoedBy: CouncilAgentId | null = null

  for (const id of COUNCIL_AGENT_IDS) {
    const v = raw[id]
    const weight = 1
    votes[id] = { ...v, weight }
    if (v.confidence === 0) continue
    weighted += voteScore(v) * weight
    totalWeight += weight
    if (v.vote === 'AVOID' && v.confidence >= VETO_CONFIDENCE) vetoedBy = vetoedBy ?? id
  }

  const consensus = totalWeight > 0 ? (weighted / totalWeight + 1) / 2 : 0.5
  const buyVotes = COUNCIL_AGENT_IDS.filter((id) => votes[id].vote === 'BUY' && votes[id].confidence > 0).length
  const coreAligned = votes.momentum.vote === 'BUY' && votes.technical.vote === 'BUY'
  const enoughBuys = buyVotes >= MIN_BUY_VOTES || (coreAligned && buyVotes >= 2)

  const orderSizeUsd = Math.min(
    settings.maxTradeUsd,
    Math.floor(Math.min(freeUsdt * 0.95, settings.maxTradeUsd) * 100) / 100,
  )

  const action: 'BUY' | 'HOLD' =
    !settings.hasOpenLong &&
    orderSizeUsd >= 5 &&
    consensus >= BASE_THRESHOLD &&
    enoughBuys &&
    !vetoedBy &&
    riskVote.vote === 'BUY'
      ? 'BUY'
      : 'HOLD'

  const reasons: string[] = []
  if (tech.context?.available) {
    reasons.push(`${tech.context.headline} (${tech.context.dataQuality} history)`)
  }
  if (action === 'BUY') {
    reasons.push(
      `CEX council ${(consensus * 100).toFixed(0)}% ≥ ${(BASE_THRESHOLD * 100).toFixed(0)}% · ${buyVotes} BUY votes`,
      `Venue: Binance spot order book · $${orderSizeUsd.toFixed(2)} USDT`,
    )
    if (llm.provider) reasons.push(`LLM (${llm.provider}): ${llm.reason}`)
  } else if (vetoedBy) {
    reasons.push(`Vetoed by ${AGENT_LABELS[vetoedBy]}: ${votes[vetoedBy].reason}`)
  } else if (consensus < BASE_THRESHOLD) {
    reasons.push(`Consensus ${(consensus * 100).toFixed(0)}% below bar ${(BASE_THRESHOLD * 100).toFixed(0)}%`)
  } else if (!enoughBuys) {
    reasons.push(`Only ${buyVotes} BUY vote(s) — need stronger agreement`)
  } else if (settings.hasOpenLong) {
    reasons.push('Position open — council waiting for exit path')
  }

  const decision: CouncilDecision = {
    id: genId(),
    userId,
    timestamp: new Date().toISOString(),
    symbol: base,
    action,
    consensus,
    threshold: BASE_THRESHOLD,
    votes,
    vetoedBy,
    orderSizeUsd: action === 'BUY' ? orderSizeUsd : 0,
    reasons,
    llmProvider: llm.provider,
    tradeId: null,
    regime:
      tech.context?.available && tech.context.regime !== 'unknown'
        ? tech.context.regime
        : snapshot?.recommendation.invest === 'yes'
          ? 'risk_on'
          : 'neutral',
    winRateTarget: WIN_RATE_TARGET,
    rollingWinRatePct: null,
  }

  lastVotesByUser.set(userId, votes)
  const list = recentByUser.get(userId) ?? []
  list.unshift(decision)
  if (list.length > 200) list.pop()
  recentByUser.set(userId, list)

  try {
    await prisma.executionEvent.create({
      data: {
        userId,
        eventType: ExecutionEventType.SIGNAL_GENERATED,
        payload: JSON.parse(
          JSON.stringify({
            source: 'binance-cex-council',
            venueClass: 'cex',
            adapterId: 'binance-spot',
            watchSymbol: symbol,
            ...decision,
          }),
        ),
      },
    })
  } catch (err) {
    logger.warn({ err }, '[cex-council] persist failed')
  }

  const io = getSocketIo()
  io?.to(`user:${userId}`).emit('council:decision', { ...decision, venue: 'binance-cex' })
  io?.to(`user:${userId}`).emit('cex-council:decision', decision)

  return decision
}

export function getCexCouncilStatus(userId: string): {
  venue: 'binance-cex'
  agents: AgentPerformance[]
  llmConfigured: boolean
  threshold: number
  lastDecision: CouncilDecision | null
} {
  const votes = lastVotesByUser.get(userId) ?? null
  const agents: AgentPerformance[] = COUNCIL_AGENT_IDS.map((id) => ({
    id,
    label: AGENT_LABELS[id],
    weight: 1,
    accuracyPct: null,
    samples: 0,
    lastVote: votes?.[id] ?? null,
  }))
  return {
    venue: 'binance-cex',
    agents,
    llmConfigured: isLlmConfigured(),
    threshold: BASE_THRESHOLD,
    lastDecision: (recentByUser.get(userId) ?? [])[0] ?? null,
  }
}

export function getRecentCexCouncilDecisions(userId: string, limit = 40): CouncilDecision[] {
  return (recentByUser.get(userId) ?? []).slice(0, limit)
}
