/**
 * Agent Council — multi-agent consensus layer for the Jupiter Super Machine.
 *
 * Architecture (OctoBot multi-evaluator × LLM_trader brain):
 *   5 voters — Momentum, Sentiment (Oracle), Technical Analyst, Risk Manager
 *   (meta-policy), LLM Strategist — each vote BUY/HOLD/AVOID with confidence.
 *   A weighted consensus decides; a high-confidence AVOID from any voter is a
 *   veto. Weights adapt to each agent's historical accuracy (reflection), and
 *   the entry threshold self-tunes toward the 65–70% win-rate target band.
 *
 * Every decision is kept in memory for the live dashboard and BUY/blocked
 * decisions are persisted as ExecutionEvents so managers can audit history.
 */
import { ExecutionEventType, TradeStatus, prisma } from '@cryptoflow/db'
import { logger } from '../../lib/logger'
import { getSocketIo } from '../../lib/realtimeHub'
import { evaluateJupiterRisk, type RiskDecision, type SuperMachineSettings } from './jupiterRiskAgent'
import { technicalVote, type AgentVote, type TechnicalSnapshot } from './technicalAgent'
import { summarizeContext } from '../market/marketContextService'
import { isLlmConfigured, llmStrategistVote, type LlmVote } from './llmStrategist'
import { JUPITER_STRATEGY_NAME } from '../dex/jupiterSwapService'

export const COUNCIL_AGENT_IDS = [
  'momentum',
  'sentiment',
  'technical',
  'risk',
  'llm',
  'orderbook',
  'volatility',
] as const
export type CouncilAgentId = (typeof COUNCIL_AGENT_IDS)[number]

export type CouncilVotes = Record<CouncilAgentId, AgentVote & { weight: number }>

export type CouncilDecision = {
  id: string
  userId: string
  timestamp: string
  symbol: string | null
  action: 'BUY' | 'HOLD'
  consensus: number
  threshold: number
  votes: CouncilVotes
  vetoedBy: CouncilAgentId | null
  orderSizeUsd: number
  reasons: string[]
  llmProvider: string | null
  tradeId: string | null
  regime: string
  winRateTarget: { min: number; max: number }
  rollingWinRatePct: number | null
}

export type AgentPerformance = {
  id: CouncilAgentId
  label: string
  weight: number
  accuracyPct: number | null
  samples: number
  lastVote: AgentVote | null
}

const AGENT_LABELS: Record<CouncilAgentId, string> = {
  momentum: 'Momentum Scanner',
  sentiment: 'Sentiment Oracle',
  technical: 'Technical Analyst',
  risk: 'Risk Manager',
  llm: 'LLM Strategist',
  orderbook: 'Order Book Flow',
  volatility: 'Volatility Regime',
}

const WIN_RATE_TARGET = { min: 65, max: 70 }
/** Minimum weighted consensus for BUY — raised for demo-quality entries. */
const BASE_THRESHOLD = 0.63
/** Votes below this confidence are treated as offline / non-counting. */
const MIN_VOTE_CONFIDENCE = 0.63
/** Momentum, technical, and risk must reach this bar to vote BUY. */
const CORE_BUY_CONFIDENCE = 0.9
const CORE_AGENT_IDS: CouncilAgentId[] = ['momentum', 'technical', 'risk']
const VETO_CONFIDENCE = 0.72
/** Require stronger agreement before auto-buying (was 2). */
const MIN_BUY_VOTES = 3
const MAX_MEMORY_DECISIONS = 2000

const recentDecisions = new Map<string, CouncilDecision[]>()
const lastVotes = new Map<string, CouncilVotes>()

let strategyIdCache: string | null = null

async function jupiterStrategyId(): Promise<string> {
  if (strategyIdCache) return strategyIdCache
  const s = await prisma.strategy.findFirst({ where: { name: JUPITER_STRATEGY_NAME }, select: { id: true } })
  if (!s) throw new Error('DEX Jupiter SOL strategy missing')
  strategyIdCache = s.id
  return s.id
}

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function voteScore(v: AgentVote): number {
  if (v.vote === 'BUY') return v.confidence
  if (v.vote === 'AVOID') return -v.confidence
  return 0
}

/** Rolling win rate over the last N closed Jupiter trades. */
export async function rollingWinRate(userId: string, take = 20): Promise<{ pct: number | null; samples: number }> {
  const strategyId = await jupiterStrategyId()
  const closed = await prisma.trade.findMany({
    where: { userId, strategyId, status: TradeStatus.CLOSED, pnl: { not: null } },
    orderBy: { createdAt: 'desc' },
    take,
    select: { pnl: true },
  })
  if (closed.length === 0) return { pct: null, samples: 0 }
  const wins = closed.filter((t) => Number(t.pnl) > 0).length
  return { pct: (wins / closed.length) * 100, samples: closed.length }
}

/**
 * Win-rate targeting: below the 65% floor the entry bar rises (trade less,
 * only take the strongest setups); above 70% it relaxes slightly to capture
 * more volume while staying in band.
 */
export function adaptiveThreshold(winRatePct: number | null, samples: number): number {
  if (winRatePct == null || samples < 8) return BASE_THRESHOLD
  if (winRatePct < WIN_RATE_TARGET.min) {
    const deficit = (WIN_RATE_TARGET.min - winRatePct) / 100
    return Math.min(0.68, BASE_THRESHOLD + deficit * 0.5 + 0.02)
  }
  if (winRatePct > WIN_RATE_TARGET.max) return Math.max(0.5, BASE_THRESHOLD - 0.03)
  return BASE_THRESHOLD
}

/**
 * Reflection: per-agent accuracy from decisions that became real trades.
 * An agent is "correct" when it voted BUY and the trade won, or voted AVOID
 * and the trade lost. HOLD votes are neutral.
 */
export async function agentAccuracy(userId: string): Promise<Record<CouncilAgentId, { accuracyPct: number | null; samples: number }>> {
  const events = await prisma.executionEvent.findMany({
    where: {
      userId,
      eventType: ExecutionEventType.SIGNAL_GENERATED,
      payload: { path: ['source'], equals: 'jupiter-council' },
    },
    orderBy: { createdAt: 'desc' },
    take: 120,
    select: { payload: true },
  })

  const tradeIds: string[] = []
  const byTrade = new Map<string, CouncilVotes>()
  for (const e of events) {
    const p = e.payload as { tradeId?: string | null; votes?: CouncilVotes } | null
    if (p?.tradeId && p.votes) {
      tradeIds.push(p.tradeId)
      byTrade.set(p.tradeId, p.votes)
    }
  }

  const out = {} as Record<CouncilAgentId, { accuracyPct: number | null; samples: number }>
  for (const id of COUNCIL_AGENT_IDS) out[id] = { accuracyPct: null, samples: 0 }
  if (tradeIds.length === 0) return out

  const trades = await prisma.trade.findMany({
    where: { id: { in: tradeIds }, status: TradeStatus.CLOSED, pnl: { not: null } },
    select: { id: true, pnl: true },
  })

  const tally = {} as Record<CouncilAgentId, { correct: number; total: number }>
  for (const id of COUNCIL_AGENT_IDS) tally[id] = { correct: 0, total: 0 }

  for (const t of trades) {
    const votes = byTrade.get(t.id)
    if (!votes) continue
    const won = Number(t.pnl) > 0
    for (const id of COUNCIL_AGENT_IDS) {
      const v = votes[id]
      if (!v || v.vote === 'HOLD' || v.confidence === 0) continue
      tally[id].total++
      if ((v.vote === 'BUY' && won) || (v.vote === 'AVOID' && !won)) tally[id].correct++
    }
  }

  for (const id of COUNCIL_AGENT_IDS) {
    const { correct, total } = tally[id]
    out[id] = { accuracyPct: total >= 3 ? (correct / total) * 100 : null, samples: total }
  }
  return out
}

/** Reflection-adjusted weight: proven agents count more, weak ones less. */
function accuracyWeight(accuracyPct: number | null): number {
  if (accuracyPct == null) return 1.0
  return Math.min(1.4, Math.max(0.6, 0.6 + (accuracyPct / 100) * 0.8))
}

function applyConfidenceGates(id: CouncilAgentId, v: AgentVote): AgentVote {
  if (v.confidence > 0 && v.confidence < MIN_VOTE_CONFIDENCE) {
    return {
      vote: 'HOLD',
      confidence: 0,
      reason: `${v.reason} (below ${(MIN_VOTE_CONFIDENCE * 100).toFixed(0)}% confidence floor)`,
    }
  }
  if (CORE_AGENT_IDS.includes(id) && v.vote === 'BUY' && v.confidence < CORE_BUY_CONFIDENCE) {
    return {
      vote: 'HOLD',
      confidence: v.confidence,
      reason: `${v.reason} (core agent needs ≥${(CORE_BUY_CONFIDENCE * 100).toFixed(0)}% to BUY)`,
    }
  }
  return v
}

export async function councilEvaluate(opts: {
  userId: string
  settings: SuperMachineSettings
  openCount: number
  openBases: Set<string>
}): Promise<{ decision: CouncilDecision; risk: RiskDecision }> {
  const { userId } = opts

  const [risk, accuracy, winRate] = await Promise.all([
    evaluateJupiterRisk(opts),
    agentAccuracy(userId).catch(() => null),
    rollingWinRate(userId).catch(() => ({ pct: null, samples: 0 })),
  ])

  const threshold = adaptiveThreshold(winRate.pct, winRate.samples)
  const pick = risk.pick

  // ── Assemble the five votes ────────────────────────────────────────────
  const momentum: AgentVote = pick
    ? {
        vote:
          risk.momentumScore >= CORE_BUY_CONFIDENCE
            ? 'BUY'
            : risk.momentumScore <= 0.3
              ? 'AVOID'
              : 'HOLD',
        confidence: Math.min(0.95, Math.max(MIN_VOTE_CONFIDENCE, risk.momentumScore)),
        reason: pick
          ? `${pick.baseSymbol} ${pick.signal} · momentum ${(risk.momentumScore * 100).toFixed(0)}% · vol score ${(risk.volumeScore * 100).toFixed(0)}%`
          : 'No pick',
      }
    : { vote: 'HOLD', confidence: 0, reason: 'No trending token passed filters' }

  const oracle = risk.oracle
  const sentiment: AgentVote = oracle
    ? oracle.sentimentScore < -0.35 && oracle.confidence > 0.4
      ? { vote: 'AVOID', confidence: Math.min(0.9, oracle.confidence + 0.2), reason: 'Negative SOL news flow' }
      : oracle.sentimentScore > 0.2 && oracle.confidence > 0.35
        ? { vote: 'BUY', confidence: Math.min(0.85, 0.5 + oracle.sentimentScore * 0.5), reason: oracle.catalyst ?? 'Positive news sentiment' }
        : { vote: 'HOLD', confidence: 0.45, reason: 'Neutral news flow' }
    : { vote: 'HOLD', confidence: 0.35, reason: 'No sentiment data yet' }

  let technical: TechnicalSnapshot | AgentVote
  if (pick) {
    technical = await technicalVote(pick.binanceSymbol)
    // Only hard-block when every candle + live price source failed entirely.
    if (technical.reason === 'Candle data unavailable') {
      technical = {
        vote: 'AVOID',
        confidence: 0.78,
        reason: 'No price or candle data — entry blocked until feeds recover',
      }
    }
  } else {
    technical = { vote: 'HOLD', confidence: 0.3, reason: 'No candidate to analyze' }
  }

  const riskVote: AgentVote = risk.blocked
    ? {
        vote:
          risk.blocked === 'low_confidence' ||
          risk.blocked === 'no_qualifying_pick' ||
          risk.blocked === 'max_open_positions'
            ? 'HOLD'
            : 'AVOID',
        confidence: 0.75,
        reason: risk.reasons[0] ?? `Gate: ${risk.blocked.replace(/_/g, ' ')}`,
      }
    : {
        vote: risk.pUp >= CORE_BUY_CONFIDENCE ? 'BUY' : 'HOLD',
        confidence: Math.min(0.95, Math.max(MIN_VOTE_CONFIDENCE, risk.pUp)),
        reason: `Regime ${risk.regime} · pUp ${(risk.pUp * 100).toFixed(0)}%`,
      }

  // LLM only consulted when there is a live candidate that passed the gates —
  // saves quota and keeps latency out of no-op ticks.
  let llm: LlmVote = {
    vote: 'HOLD',
    confidence: 0,
    reason: isLlmConfigured() ? 'Consulted only on live candidates' : 'LLM offline — no provider key configured',
    provider: null,
    latencyMs: null,
  }
  if (pick && !risk.blocked) {
    const tech = technical as TechnicalSnapshot
    llm = await llmStrategistVote({
      symbol: pick.baseSymbol,
      priceUsd: pick.usdPrice,
      change5mPct: pick.change5m,
      change1hPct: pick.change1h,
      change24hPct: pick.change24h,
      liquidityUsd: pick.liquidityUsd,
      volume24hUsd: pick.volume24hUsd,
      momentumScore: risk.momentumScore,
      rsi14: tech.rsi14 ?? null,
      emaCrossBull: tech.emaCrossBull ?? null,
      trendStrength: tech.trendStrength ?? 0.5,
      newsSentiment: oracle?.sentimentScore ?? null,
      solSpreadBps: risk.quant?.spreadBps ?? null,
      orderBookImbalance: risk.quant?.obi ?? null,
      recentWinRatePct: winRate.pct,
      marketContext: tech.context ? summarizeContext(tech.context) : null,
    })
  }

  // Order-book imbalance (quant bus) + volatility regime from trend strength.
  const obi = risk.quant?.obi ?? null
  const orderbook: AgentVote =
    obi == null
      ? { vote: 'HOLD', confidence: 0.3, reason: 'Order-book imbalance unavailable' }
      : obi > 0.18
        ? {
            vote: 'BUY',
            confidence: Math.min(0.85, 0.45 + obi * 0.6),
            reason: `Bid-heavy book · OBI ${obi.toFixed(2)}`,
          }
        : obi < -0.18
          ? {
              vote: 'AVOID',
              confidence: Math.min(0.85, 0.45 + Math.abs(obi) * 0.6),
              reason: `Ask-heavy book · OBI ${obi.toFixed(2)}`,
            }
          : { vote: 'HOLD', confidence: 0.4, reason: `Balanced book · OBI ${obi.toFixed(2)}` }

  const techSnap = technical as TechnicalSnapshot
  const trend = techSnap.trendStrength ?? 0.5
  const volatility: AgentVote =
    trend >= 0.72
      ? {
          vote: 'BUY',
          confidence: Math.min(0.82, 0.4 + trend * 0.45),
          reason: `Trend strength ${(trend * 100).toFixed(0)}% — momentum regime`,
        }
      : trend <= 0.28
        ? {
            vote: 'AVOID',
            confidence: 0.7,
            reason: `Weak/choppy regime · strength ${(trend * 100).toFixed(0)}%`,
          }
        : {
            vote: 'HOLD',
            confidence: 0.42,
            reason: `Neutral vol regime · strength ${(trend * 100).toFixed(0)}%`,
          }

  // ── Weighted consensus with reflection-adjusted weights ────────────────
  const votes = {} as CouncilVotes
  const rawVotes: Record<CouncilAgentId, AgentVote> = {
    momentum: applyConfidenceGates('momentum', momentum),
    sentiment: applyConfidenceGates('sentiment', sentiment),
    technical: applyConfidenceGates('technical', technical as AgentVote),
    risk: applyConfidenceGates('risk', riskVote),
    llm: applyConfidenceGates('llm', llm),
    orderbook: applyConfidenceGates('orderbook', orderbook),
    volatility: applyConfidenceGates('volatility', volatility),
  }
  let weighted = 0
  let totalWeight = 0
  let vetoedBy: CouncilAgentId | null = null

  for (const id of COUNCIL_AGENT_IDS) {
    const v = rawVotes[id]
    const weight = accuracyWeight(accuracy?.[id]?.accuracyPct ?? null)
    votes[id] = { ...v, weight }
    if (v.confidence === 0) continue // offline agent — excluded from consensus
    weighted += voteScore(v) * weight
    totalWeight += weight
    if (v.vote === 'AVOID' && v.confidence >= VETO_CONFIDENCE) vetoedBy = vetoedBy ?? id
  }

  const consensus = totalWeight > 0 ? (weighted / totalWeight + 1) / 2 : 0.5
  const buyVotes = COUNCIL_AGENT_IDS.filter((id) => votes[id].vote === 'BUY' && votes[id].confidence > 0).length

  // Prefer momentum+technical agreement; otherwise require MIN_BUY_VOTES agents.
  const coreAligned =
    votes.momentum.vote === 'BUY' &&
    votes.technical.vote === 'BUY' &&
    votes.risk.vote === 'BUY' &&
    votes.momentum.confidence >= CORE_BUY_CONFIDENCE &&
    votes.technical.confidence >= CORE_BUY_CONFIDENCE &&
    votes.risk.confidence >= CORE_BUY_CONFIDENCE
  const enoughBuys = buyVotes >= MIN_BUY_VOTES || (coreAligned && buyVotes >= 2)
  const action: 'BUY' | 'HOLD' =
    !risk.blocked && risk.action === 'BUY' && consensus >= threshold && enoughBuys && !vetoedBy ? 'BUY' : 'HOLD'

  const reasons: string[] = []
  if (action === 'BUY') {
    reasons.push(
      `Council consensus ${(consensus * 100).toFixed(0)}% ≥ bar ${(threshold * 100).toFixed(0)}% (${buyVotes} BUY votes)`,
      ...risk.reasons.slice(0, 3),
    )
    if (llm.provider) reasons.push(`LLM (${llm.provider}): ${llm.reason}`)
  } else if (vetoedBy) {
    reasons.push(`Vetoed by ${AGENT_LABELS[vetoedBy]}: ${votes[vetoedBy].reason}`)
  } else if (risk.blocked) {
    reasons.push(`Risk gate: ${risk.blocked.replace(/_/g, ' ')}`)
  } else if (consensus < threshold) {
    reasons.push(`Consensus ${(consensus * 100).toFixed(0)}% below adaptive bar ${(threshold * 100).toFixed(0)}%`)
  } else if (!enoughBuys) {
    reasons.push(`Only ${buyVotes} BUY vote(s) — need ${MIN_BUY_VOTES} agents, or momentum+technical both BUY`)
  }

  const decision: CouncilDecision = {
    id: genId(),
    userId,
    timestamp: new Date().toISOString(),
    symbol: pick?.baseSymbol ?? null,
    action,
    consensus,
    threshold,
    votes,
    vetoedBy,
    orderSizeUsd: action === 'BUY' ? risk.orderSizeUsd : 0,
    reasons,
    llmProvider: llm.provider,
    tradeId: null,
    regime: risk.regime,
    winRateTarget: WIN_RATE_TARGET,
    rollingWinRatePct: winRate.pct,
  }

  rememberDecision(decision)
  lastVotes.set(userId, votes)

  // Persist every tick so decision history never disappears after refresh.
  void persistCouncilDecision(decision, null)

  const io = getSocketIo()
  io?.to(`user:${userId}`).emit('council:decision', decision)

  return { decision, risk }
}

function rememberDecision(decision: CouncilDecision): void {
  const list = recentDecisions.get(decision.userId) ?? []
  list.unshift(decision)
  if (list.length > MAX_MEMORY_DECISIONS) list.pop()
  recentDecisions.set(decision.userId, list)
}

/** Persist every council decision to the DB for full audit history. */
export async function persistCouncilDecision(decision: CouncilDecision, tradeId: string | null): Promise<void> {
  decision.tradeId = tradeId
  try {
    await prisma.executionEvent.create({
      data: {
        userId: decision.userId,
        eventType: ExecutionEventType.SIGNAL_GENERATED,
        payload: JSON.parse(JSON.stringify({ source: 'jupiter-council', ...decision })),
      },
    })
  } catch (err) {
    logger.warn({ err }, '[council] failed to persist decision')
  }
}

export function getRecentCouncilDecisions(userId: string, limit = 40): CouncilDecision[] {
  return (recentDecisions.get(userId) ?? []).slice(0, limit)
}

export async function getCouncilStatus(userId: string): Promise<{
  agents: AgentPerformance[]
  llmConfigured: boolean
  threshold: number
  rollingWinRatePct: number | null
  winRateSamples: number
  winRateTarget: { min: number; max: number }
  lastDecision: CouncilDecision | null
}> {
  const [accuracy, winRate] = await Promise.all([
    agentAccuracy(userId).catch(() => null),
    rollingWinRate(userId).catch(() => ({ pct: null, samples: 0 })),
  ])
  const votes = lastVotes.get(userId) ?? null
  const agents: AgentPerformance[] = COUNCIL_AGENT_IDS.map((id) => ({
    id,
    label: AGENT_LABELS[id],
    weight: accuracyWeight(accuracy?.[id]?.accuracyPct ?? null),
    accuracyPct: accuracy?.[id]?.accuracyPct ?? null,
    samples: accuracy?.[id]?.samples ?? 0,
    lastVote: votes?.[id] ?? null,
  }))
  return {
    agents,
    llmConfigured: isLlmConfigured(),
    threshold: adaptiveThreshold(winRate.pct, winRate.samples),
    rollingWinRatePct: winRate.pct,
    winRateSamples: winRate.samples,
    winRateTarget: WIN_RATE_TARGET,
    lastDecision: getRecentCouncilDecisions(userId, 1)[0] ?? null,
  }
}

/** Durable decision history — DB is source of truth, merged with in-memory buffer. */
export async function getCouncilDecisionHistory(userId: string, limit = 500): Promise<CouncilDecision[]> {
  const take = Math.min(2000, Math.max(1, limit))
  const byId = new Map<string, CouncilDecision>()

  try {
    const events = await prisma.executionEvent.findMany({
      where: {
        userId,
        eventType: ExecutionEventType.SIGNAL_GENERATED,
        payload: { path: ['source'], equals: 'jupiter-council' },
      },
      orderBy: { createdAt: 'desc' },
      take,
      select: { payload: true },
    })
    for (const e of events) {
      const p = e.payload as unknown as CouncilDecision & { source?: string }
      if (p?.id) byId.set(p.id, p)
    }
  } catch (err) {
    logger.debug({ err }, '[council] history query failed')
  }

  for (const d of recentDecisions.get(userId) ?? []) {
    if (d.id && !byId.has(d.id)) byId.set(d.id, d)
  }

  return [...byId.values()].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
}
