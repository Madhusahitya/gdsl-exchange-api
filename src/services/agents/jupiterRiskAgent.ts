/**
 * Agent 3: Risk Analyst v2 — Enhanced fusion of Jupiter momentum, oracle sentiment, 
 * quant book analysis, and meta-policy with profit optimization focus.
 * 
 * ACCURACY IMPROVEMENTS:
 * - Multi-timeframe momentum analysis
 * - Volume-weighted signal scoring  
 * - Adaptive confidence thresholds based on market volatility
 * - Smart entry timing with market microstructure analysis
 */
import { agentBus, markAgentTick } from './agentBus'
import type { OraclePayload } from './oracleAgent'
import type { QuantPayload } from './quantAgent'
import { decide } from '../bot/metaPolicy'
import { getJupiterTradeSuggestions, type TradeSuggestion } from '../dex/jupiterTrendingService'
import { getJupiterTradeSignals } from '../dex/jupiterSignalService'
import { isTier1Major } from '../../lib/tier1Majors'
import { compareTradeRank } from './candidateRank'
import { logger } from '../../lib/logger'

export type SuperMachineSettings = {
  maxTradeUsd: number
  maxOpenPositions: number
  minLiquidityUsd: number
  minSignal: 'rising' | 'strong'
  /** When set, only this binanceSymbol (e.g. SOLUSDT) may be picked. */
  watchSymbol?: string | null
}

export type RiskDecision = {
  action: 'BUY' | 'HOLD'
  pick: TradeSuggestion | null
  confidence: number
  orderSizeUsd: number
  blocked: string | null
  reasons: string[]
  quant: QuantPayload | null
  oracle: OraclePayload | null
  regime: string
  pUp: number
  entryScore: number
  volumeScore: number
  momentumScore: number
}

function signalRank(s: TradeSuggestion['signal']): number {
  if (s === 'strong') return 3
  if (s === 'rising') return 2
  if (s === 'watch') return 1
  return 0
}

function calculateVolumeScore(suggestion: TradeSuggestion): number {
  const volumeUsd = suggestion.volume24hUsd || 0
  if (volumeUsd > 10_000_000) return 1.0
  if (volumeUsd > 1_000_000) return 0.85
  if (volumeUsd > 500_000) return 0.7
  if (volumeUsd > 100_000) return 0.55
  return 0.4
}

function calculateMomentumScore(suggestion: TradeSuggestion, signals: Array<{ symbol: string; action: string; score: number }>): number {
  const matchingSignal = signals.find((s) => s.symbol === suggestion.binanceSymbol)
  
  let score = suggestion.score / 100
  
  if (matchingSignal?.action === 'BUY') {
    score += 0.15
  }
  
  if (suggestion.change1h > 0 && suggestion.change1h < 8) {
    score += 0.1
  } else if (suggestion.change1h > 15) {
    score -= 0.1
  }
  
  if (suggestion.change24h > 0 && suggestion.change24h < 20) {
    score += 0.05
  } else if (suggestion.change24h > 50) {
    score -= 0.15
  } else if (suggestion.change24h < -20) {
    score -= 0.1
  }
  
  return Math.max(0, Math.min(1, score))
}

function calculateEntryScore(quant: QuantPayload | null, oracle: OraclePayload | null): number {
  let score = 0.5
  
  if (quant) {
    if (quant.spreadBps < 8) score += 0.15
    else if (quant.spreadBps < 15) score += 0.08
    else if (quant.spreadBps > 25) score -= 0.1
    
    if (quant.obi !== null && quant.obi !== undefined) {
      if (quant.obi > 0.2) score += 0.12
      else if (quant.obi > 0.05) score += 0.06
      else if (quant.obi < -0.15) score -= 0.1
    }
  }
  
  if (oracle) {
    if (oracle.sentimentScore > 0.3 && oracle.confidence > 0.4) {
      score += 0.1
    } else if (oracle.sentimentScore < -0.2 && oracle.confidence > 0.4) {
      score -= 0.08
    }
  }
  
  return Math.max(0, Math.min(1, score))
}

/**
 * Overextension hard gate — buying a token already up big in the last minutes
 * means buying someone else's exit. These are hard rejects, not soft penalties.
 */
const MAX_CHANGE_5M_PCT = 8
const MAX_CHANGE_1H_PCT = 20
const MAX_CHANGE_24H_PCT = 60

function isOverextended(item: TradeSuggestion): string | null {
  if (item.change5m > MAX_CHANGE_5M_PCT) return `+${item.change5m.toFixed(1)}% in 5m — chasing a pump`
  if (item.change1h > MAX_CHANGE_1H_PCT) return `+${item.change1h.toFixed(1)}% in 1h — overextended`
  if (item.change24h > MAX_CHANGE_24H_PCT) return `+${item.change24h.toFixed(1)}% in 24h — blow-off risk`
  return null
}

type ScoredPick = {
  pick: TradeSuggestion
  volumeScore: number
  momentumScore: number
  totalScore: number
}

function rankTokens(
  suggestions: TradeSuggestion[],
  settings: SuperMachineSettings,
  openBases: Set<string>,
  signals: Array<{ symbol: string; action: string; score: number }>,
): ScoredPick[] {
  const minRank = settings.minSignal === 'strong' ? 3 : 2

  const scored: Array<ScoredPick & { isMajor: boolean }> = []

  for (const item of suggestions) {
    if (settings.watchSymbol) {
      const want = settings.watchSymbol.toUpperCase()
      if (item.binanceSymbol.toUpperCase() !== want) continue
    }
    if (signalRank(item.signal) < minRank) continue
    if (item.liquidityUsd < settings.minLiquidityUsd) continue
    if (openBases.has(item.baseSymbol.toUpperCase())) continue
    if (isOverextended(item)) continue

    const volumeScore = calculateVolumeScore(item)
    const momentumScore = calculateMomentumScore(item, signals)
    const totalScore = volumeScore * 0.35 + momentumScore * 0.65

    scored.push({
      pick: item,
      volumeScore,
      momentumScore,
      totalScore,
      isMajor: isTier1Major(item.baseSymbol),
    })
  }

  scored.sort(compareTradeRank)
  return scored
}

function calculateAdaptiveThreshold(quant: QuantPayload | null): number {
  const baseThreshold = 0.48
  
  if (!quant) return baseThreshold
  
  if (quant.spreadBps > 20) {
    return baseThreshold + 0.08
  } else if (quant.spreadBps < 10) {
    return baseThreshold - 0.03
  }
  
  return baseThreshold
}

export async function evaluateJupiterRisk(opts: {
  userId: string
  settings: SuperMachineSettings
  openCount: number
  openBases: Set<string>
  equityUsdt?: number
}): Promise<RiskDecision> {
  const { userId, settings, openCount, openBases } = opts
  const equity = opts.equityUsdt ?? 1000

  const defaultDecision = (blocked: string, reason: string, quant: QuantPayload | null = null, oracle: OraclePayload | null = null): RiskDecision => ({
    action: 'HOLD',
    pick: null,
    confidence: 0,
    orderSizeUsd: 0,
    blocked,
    reasons: [reason],
    quant,
    oracle,
    regime: 'N/A',
    pUp: 0,
    entryScore: 0,
    volumeScore: 0,
    momentumScore: 0,
  })

  try {
    const quant = agentBus.getCached<QuantPayload>('market:tick', 'quant')
    const oracle = agentBus.getCached<OraclePayload>('sentiment:update', 'oracle')

    if (openCount >= settings.maxOpenPositions) {
      return defaultDecision('max_open_positions', `At max open positions (${openCount})`, quant, oracle)
    }

    if (quant && quant.spreadBps > 35) {
      return defaultDecision('sol_spread_wide', `SOL spread ${quant.spreadBps.toFixed(1)} bps too wide — market stressed`, quant, oracle)
    }

    if (quant?.obi !== null && quant?.obi !== undefined && quant.obi < -0.4) {
      return defaultDecision('order_book_adverse', 'Heavy sell pressure in order book (minimax filter)', quant, oracle)
    }

    if (oracle && oracle.sentimentScore < -0.45 && oracle.confidence > 0.5) {
      return defaultDecision('extreme_negative_sentiment', 'Oracle detects extreme negative news flow — risk off', quant, oracle)
    }

    const [{ items: suggestions }, { signals }] = await Promise.all([
      getJupiterTradeSuggestions(20),
      getJupiterTradeSignals(15),
    ])

    const ranked = rankTokens(suggestions, settings, openBases, signals)

    if (ranked.length === 0) {
      markAgentTick('risk')
      const lockMsg = settings.watchSymbol
        ? `Pair lock ${settings.watchSymbol}: token did not pass liquidity/signal filters`
        : 'No trending token passed liquidity/signal/volume filters'
      return defaultDecision('no_qualifying_pick', lockMsg, quant, oracle)
    }

    const entryScore = calculateEntryScore(quant, oracle)
    // Token-specific misses: try the next-best setup. Account-wide blocks stop the tick.
    const skippable = new Set(['low_confidence', 'low_volume', 'negative_sentiment'])
    const shortlist = ranked.slice(0, 3)
    let firstMiss: RiskDecision | null = null

    for (let i = 0; i < shortlist.length; i++) {
      const { pick, volumeScore, momentumScore } = shortlist[i]
      const why: string[] = []
      const boardSignal = signals.find(
        (s) => s.symbol === pick.binanceSymbol || s.baseSymbol === pick.baseSymbol,
      )
      const momentumBoost = boardSignal?.action === 'BUY' ? 0.1 : 0

      const meta = await decide(
        pick.binanceSymbol,
        userId,
        openCount > 0 ? 1 : 0,
        0,
        0,
        equity,
      )

      let sentimentBoost = 0
      if (oracle && oracle.confidence > 0.35) {
        // SOL-only news: only boost SOL picks meaningfully; mute for unrelated tokens.
        const isSolPick = pick.baseSymbol.toUpperCase() === 'SOL'
        sentimentBoost = oracle.sentimentScore * (isSolPick ? 0.08 : 0.02)
      }

      const hold = (
        blocked: string,
        holdReasons: string[],
        confidence = 0,
        orderSizeUsd = 0,
      ): RiskDecision => ({
        action: 'HOLD',
        pick,
        confidence,
        orderSizeUsd,
        blocked,
        reasons: holdReasons,
        quant,
        oracle,
        regime: meta.regime,
        pUp: meta.pUp,
        entryScore,
        volumeScore,
        momentumScore,
      })

      if (oracle && oracle.sentimentScore < -0.35 && oracle.confidence > 0.45 && pick.baseSymbol.toUpperCase() === 'SOL') {
        const miss = hold('negative_sentiment', ['Oracle: significant negative SOL news flow — pausing SOL entries'])
        if (!firstMiss) firstMiss = miss
        continue
      }

      // Prefer Jupiter momentum/volume for Solana execution; CEX meta-policy is a soft bias only.
      const isSolPick = pick.baseSymbol.toUpperCase() === 'SOL'
      const metaWeight = isSolPick ? 0.45 : 0.15
      const jupiterWeight = isSolPick ? 0.35 : 0.7
      const rawConfidence =
        meta.pUp * metaWeight +
        momentumBoost +
        sentimentBoost +
        (pick.score / 100) * jupiterWeight +
        entryScore * 0.1 +
        volumeScore * 0.08
      const confidence = Math.min(1, Math.max(0, rawConfidence))
      const orderSizeUsd = Math.min(settings.maxTradeUsd, meta.orderSizeUsdt || settings.maxTradeUsd)

      if (meta.blocked) {
        return hold(meta.blocked, [`Meta-policy blocked: ${meta.blocked}`], confidence)
      }

      const adaptiveThreshold = calculateAdaptiveThreshold(quant)

      if (confidence < adaptiveThreshold) {
        why.push(`Confidence ${(confidence * 100).toFixed(0)}% below adaptive threshold ${(adaptiveThreshold * 100).toFixed(0)}%`)
        const miss = hold('low_confidence', why, confidence)
        if (!firstMiss) firstMiss = miss
        continue
      }

      if (volumeScore < 0.45) {
        why.push(`Volume score ${(volumeScore * 100).toFixed(0)}% below threshold — thin liquidity risk`)
        const miss = hold('low_volume', why, confidence)
        if (!firstMiss) firstMiss = miss
        continue
      }

      why.push(
        `${pick.baseSymbol} ${pick.signal} · raw=${pick.score.toFixed(0)} vol=${(volumeScore * 100).toFixed(0)}%`,
        `Meta ${meta.regime} pUp=${(meta.pUp * 100).toFixed(0)}%`,
        `Entry=${(entryScore * 100).toFixed(0)}% Mom=${(momentumScore * 100).toFixed(0)}%`,
      )
      if (i > 0) why.push(`Skipped ${i} weaker or gated name${i === 1 ? '' : 's'} ahead of this setup`)
      if (boardSignal?.action === 'BUY') why.push(`Signal board: ${boardSignal.rationale}`)
      if (oracle?.catalyst) why.push(`Oracle: ${oracle.catalyst}`)

      const payload: RiskDecision = {
        action: 'BUY',
        pick,
        confidence,
        orderSizeUsd,
        blocked: null,
        reasons: why,
        quant,
        oracle,
        regime: meta.regime,
        pUp: meta.pUp,
        entryScore,
        volumeScore,
        momentumScore,
      }

      agentBus.publish({
        agentId: 'risk',
        stream: 'risk:signal',
        payload,
        ts: Date.now(),
        ttlMs: 60_000,
      })
      markAgentTick('risk')

      logger.info({
        userId,
        symbol: pick.baseSymbol,
        confidence: confidence.toFixed(3),
        entryScore: entryScore.toFixed(3),
        volumeScore: volumeScore.toFixed(3),
        momentumScore: momentumScore.toFixed(3),
        rank: i + 1,
      }, '[risk-v2] BUY signal generated')

      return payload
    }

    markAgentTick('risk')
    const missed = firstMiss ?? defaultDecision('no_qualifying_pick', 'No candidate cleared the entry gates', quant, oracle)
    if (shortlist.length > 1 && !skippable.has(missed.blocked ?? '')) {
      return missed
    }
    return {
      ...missed,
      reasons: [
        ...missed.reasons,
        shortlist.length > 1 ? `Checked ${shortlist.length} ranked tokens — none cleared the entry gates` : missed.reasons[0],
      ].filter((line, idx, arr) => line && arr.indexOf(line) === idx),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    markAgentTick('risk', msg)
    logger.warn({ err, userId }, '[risk-v2] Jupiter evaluation failed')
    return {
      action: 'HOLD',
      pick: null,
      confidence: 0,
      orderSizeUsd: 0,
      blocked: 'risk_error',
      reasons: [msg],
      quant: null,
      oracle: null,
      regime: 'ERROR',
      pUp: 0,
      entryScore: 0,
      volumeScore: 0,
      momentumScore: 0,
    }
  }
}
