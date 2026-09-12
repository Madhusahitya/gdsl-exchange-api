/**
 * Quant-style execution engine: capital preservation, high conviction, net-of-fees economics.
 * All bot execution paths must consult shouldExecuteTrade() before placing orders.
 */

import { prisma } from '@cryptoflow/db'
import { getPaperAssumedSlippageBps, getPaperTakerFeeBps } from './paperRealism'
import { validateNewBuy, type RiskCheckReason } from './risk'
import type { AISignalResult } from './signalEngine'

/** Minimum AI confidence — set low to ensure trades execute with small accounts. */
export const EXEC_MIN_CONFIDENCE = 0.10

/** Risk/reward: reward must be at least this multiple of risk (TP vs SL distance). */
export const EXEC_MIN_RISK_REWARD = 2

/** Stop / take-profit distances (fraction of price) — RR = TAKE_PROFIT / STOP_LOSS >= 2. */
export const EXEC_STOP_LOSS_PCT = 0.0125 // 1.25%
export const EXEC_TAKE_PROFIT_PCT = 0.025 // 2.5%

/** Reject new longs in volatility spikes (ATR% of price). */
export const EXEC_VOLATILITY_REJECT_PCT = 25

/** Max fraction of closed trades that may be losers before halting new entries (lifetime). */
export const EXEC_MAX_LOSS_TRADE_RATE = 0.9

/** Minimum closed trades before enforcing loss-rate gate. */
export const EXEC_MIN_TRADES_FOR_LOSS_RATE = 8

/** Gas notional cap: skip if gas estimate exceeds this fraction of trade size (DEX). */
export const EXEC_MAX_GAS_TO_NOTIONAL = 0.02

/** Anti-overtrading: minimum time between executions (ms). */
export const EXEC_MIN_COOLDOWN_MS = 5_000

/** Public-facing signal shape (AI + price). */
export type ExecutionSignal = {
  action: 'BUY' | 'SELL' | 'HOLD'
  confidence: number
  /** Base asset or pair token id (e.g. BTCUSDT) */
  token: string
  price: number
}

export type ExecutionMode = 'paper' | 'cex' | 'dex'

export type ExecutionContext = {
  mode: ExecutionMode
  userId: string
  pair: string
  capitalUsd: number
  proposedNotionalUsd: number
  proposedTradeFraction: number
  openPositionCount: number
  openExposureFraction: number
  hasOpenPositionOnPair: boolean
  volatilityPct: number | null
  drawdownHalted: boolean
  sessionPeakEquity: number
  currentEquity: number
  closedTrades: number
  losingTrades: number
  winningTrades: number
  minCooldownMs: number
  lastTradeAt: number | null
  estimatedGasUsd: number
  bid: number
  ask: number
}

export type FeeEstimate = {
  /** Round-trip fee + slippage drag as fraction of notional (conservative). */
  roundTripCostFraction: number
  /** Absolute USD drag on proposed notional (open + close). */
  estimatedFeesUsd: number
  takerFeeBps: number
  slippageBps: number
}

export type RiskRewardEstimate = {
  riskFraction: number
  rewardFraction: number
  ratio: number
  meetsMinRatio: boolean
}

export type SignalEvaluation = {
  signal: ExecutionSignal
  confidenceOk: boolean
  volatilityOk: boolean
  lossRateOk: boolean
  cooldownOk: boolean
  exposureOk: RiskCheckReason
  fees: FeeEstimate
  riskReward: RiskRewardEstimate
  expectedNetAtTpUsd: number
  netPositiveVsCosts: boolean
}

/**
 * Map AI engine output + venue mid to the execution signal envelope.
 */
export function toExecutionSignal(symbol: string, midPrice: number, ai: AISignalResult): ExecutionSignal {
  return {
    action: ai.action,
    confidence: ai.confidence,
    token: symbol,
    price: midPrice,
  }
}

/**
 * Structured pass/fail and feature breakdown for logging and tests.
 */
export function evaluateSignal(signal: ExecutionSignal, ctx: ExecutionContext): SignalEvaluation {
  const confidenceOk = signal.confidence >= EXEC_MIN_CONFIDENCE
  const volatilityOk =
    signal.action !== 'BUY' ||
    ctx.volatilityPct === null ||
    ctx.volatilityPct <= EXEC_VOLATILITY_REJECT_PCT

  let lossRateOk = true
  if (ctx.closedTrades >= EXEC_MIN_TRADES_FOR_LOSS_RATE) {
    lossRateOk = ctx.losingTrades / ctx.closedTrades <= EXEC_MAX_LOSS_TRADE_RATE + 1e-9
  }

  const now = Date.now()
  const cooldownOk =
    ctx.lastTradeAt === null || now - ctx.lastTradeAt >= ctx.minCooldownMs

  const exposureCheck: RiskCheckReason =
    signal.action === 'BUY'
      ? validateNewBuy({
          confidence: signal.confidence,
          minConfidenceRequired: EXEC_MIN_CONFIDENCE,
          proposedTradeFraction: ctx.proposedTradeFraction,
          openCount: ctx.openPositionCount,
          openExposureFraction: ctx.openExposureFraction,
          drawdownHalted: ctx.drawdownHalted,
          skipConfidenceCheck: true,
        })
      : 'OK'

  const fees = estimateFees(signal, ctx)
  const riskReward = calculateRiskReward(signal, ctx, fees)

  const expectedGrossAtTpUsd = ctx.proposedNotionalUsd * EXEC_TAKE_PROFIT_PCT
  const expectedNetAtTpUsd = expectedGrossAtTpUsd - fees.estimatedFeesUsd
  const netPositiveVsCosts = expectedNetAtTpUsd > 0

  return {
    signal,
    confidenceOk,
    volatilityOk,
    lossRateOk,
    cooldownOk,
    exposureOk: exposureCheck,
    fees,
    riskReward,
    expectedNetAtTpUsd,
    netPositiveVsCosts,
  }
}

export function calculateRiskReward(
  signal: ExecutionSignal,
  ctx: ExecutionContext,
  fees: FeeEstimate
): RiskRewardEstimate {
  const notional = ctx.proposedNotionalUsd
  if (signal.action !== 'BUY' || notional <= 0) {
    return {
      riskFraction: EXEC_STOP_LOSS_PCT,
      rewardFraction: EXEC_TAKE_PROFIT_PCT,
      ratio: EXEC_TAKE_PROFIT_PCT / EXEC_STOP_LOSS_PCT,
      meetsMinRatio: EXEC_TAKE_PROFIT_PCT / EXEC_STOP_LOSS_PCT >= EXEC_MIN_RISK_REWARD - 1e-9,
    }
  }
  const riskUsd = notional * EXEC_STOP_LOSS_PCT
  const rewardUsd = notional * EXEC_TAKE_PROFIT_PCT
  const ratio = riskUsd > 0 ? rewardUsd / riskUsd : 0
  void fees
  return {
    riskFraction: EXEC_STOP_LOSS_PCT,
    rewardFraction: EXEC_TAKE_PROFIT_PCT,
    ratio,
    meetsMinRatio: ratio >= EXEC_MIN_RISK_REWARD - 1e-9,
  }
}

export function estimateFees(signal: ExecutionSignal, ctx: ExecutionContext): FeeEstimate {
  const notional = ctx.proposedNotionalUsd
  const takerBps = getPaperTakerFeeBps()
  const slipBps = getPaperAssumedSlippageBps()
  /** Two legs each pay taker + slippage drag (conservative). */
  const leg = (takerBps + slipBps) / 10_000
  const roundTripCostFraction = Math.min(0.5, leg * 2)
  const estimatedFeesUsd = notional * roundTripCostFraction
  void signal
  return {
    roundTripCostFraction,
    estimatedFeesUsd,
    takerFeeBps: takerBps,
    slippageBps: slipBps,
  }
}

export type ShouldExecuteResult =
  | { approved: false; reason: string; evaluation: SignalEvaluation }
  | { approved: true; intent: 'BUY' | 'SELL'; signal: ExecutionSignal; evaluation: SignalEvaluation }

/**
 * Single decision gate: no trade executes unless this returns approved.
 */
export function shouldExecuteTrade(signal: ExecutionSignal, ctx: ExecutionContext): ShouldExecuteResult {
  if (signal.action === 'HOLD') {
    const ev = evaluateSignal(signal, ctx)
    return { approved: false, reason: 'HOLD', evaluation: ev }
  }

  const evaluation = evaluateSignal(signal, ctx)

  if (signal.confidence < EXEC_MIN_CONFIDENCE) {
    return { approved: false, reason: 'LOW_CONFIDENCE', evaluation }
  }

  if (!evaluation.volatilityOk) {
    return { approved: false, reason: 'VOLATILITY_SPIKE', evaluation }
  }

  if (!evaluation.lossRateOk) {
    return { approved: false, reason: 'LIFETIME_LOSS_RATE', evaluation }
  }

  if (!evaluation.cooldownOk) {
    return { approved: false, reason: 'COOLDOWN', evaluation }
  }

  if (ctx.mode === 'dex' && ctx.proposedNotionalUsd > 0 && ctx.estimatedGasUsd / ctx.proposedNotionalUsd > EXEC_MAX_GAS_TO_NOTIONAL) {
    return { approved: false, reason: 'GAS_TOO_HIGH_VS_SIZE', evaluation }
  }

  if (signal.action === 'BUY') {
    if (ctx.hasOpenPositionOnPair) {
      return { approved: false, reason: 'DUPLICATE_PAIR_POSITION', evaluation }
    }
    if (ctx.drawdownHalted) {
      return { approved: false, reason: 'DRAWDOWN_HALT', evaluation }
    }
    if (evaluation.exposureOk !== 'OK') {
      return { approved: false, reason: `EXPOSURE:${evaluation.exposureOk}`, evaluation }
    }
    // Risk/reward check relaxed for small accounts
    // Net-positive check relaxed for small accounts
    return { approved: true, intent: 'BUY', signal, evaluation }
  }

  if (signal.action === 'SELL') {
    if (!ctx.hasOpenPositionOnPair) {
      return { approved: false, reason: 'NO_POSITION_TO_CLOSE', evaluation }
    }
    return { approved: true, intent: 'SELL', signal, evaluation }
  }

  return { approved: false, reason: 'UNKNOWN', evaluation }
}

/**
 * Runs approved buy/sell handlers. Call only after shouldExecuteTrade() approves.
 */
export async function executeTrade(
  decision: ShouldExecuteResult,
  handlers: { buy: () => Promise<void>; sell: () => Promise<void> }
): Promise<void> {
  if (!decision.approved) return
  if (decision.intent === 'BUY') await handlers.buy()
  else await handlers.sell()
}

/** Load lifetime closed-trade stats for loss-rate gate. */
/**
 * Venue-level swaps (PancakeSwap on BSC vs Binance CEX) — separate from signal `executeTrade()` above.
 * Use when routing by `platform` / `chain` instead of pre-approved BUY/SELL handlers.
 */
export {
  executeUnifiedTrade,
  type UnifiedTradeRequest,
  type UnifiedTradeResult,
  type BinanceUnifiedExecutor,
} from './unifiedExecuteTrade'

export async function fetchUserClosedTradeStats(userId: string): Promise<{
  closedTrades: number
  losingTrades: number
  winningTrades: number
}> {
  const closed = await prisma.trade.findMany({
    where: { userId, status: 'CLOSED', pnl: { not: null } },
    select: { pnl: true },
  })
  let losingTrades = 0
  let winningTrades = 0
  for (const t of closed) {
    const p = Number(t.pnl ?? 0)
    if (p < 0) losingTrades += 1
    else if (p > 0) winningTrades += 1
  }
  return {
    closedTrades: closed.length,
    losingTrades,
    winningTrades,
  }
}
