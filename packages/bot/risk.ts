import { prisma } from '@cryptoflow/db'

/** Hard floor for risk checks — per-tick threshold comes from `signal.minConfidenceRequired` (dynamic). */
export const RISK = {
  MAX_CAPITAL_PER_TRADE: 0.5,
  /** Total notional exposure across open positions. */
  MAX_TOTAL_EXPOSURE: 0.8,
  MAX_OPEN_POSITIONS: 5,
  /** Global halt on new entries when session drawdown from peak exceeds this (20%). */
  MAX_DRAWDOWN: 0.2,
  /** Legacy alias: use `AISignalResult.minConfidenceRequired` for live logic. */
  MIN_SIGNAL_CONFIDENCE: 0.15,
} as const

export type RiskCheckReason =
  | 'OK'
  | 'LOW_CONFIDENCE'
  | 'MAX_POSITIONS'
  | 'MAX_EXPOSURE'
  | 'MAX_TRADE_SIZE'
  | 'DRAWDOWN_HALT'

export function checkSignalConfidence(confidence: number, minRequired: number): boolean {
  return confidence >= minRequired
}

export function checkDrawdownExceeded(currentEquity: number, peakEquity: number): boolean {
  if (peakEquity <= 0) return false
  return (peakEquity - currentEquity) / peakEquity >= RISK.MAX_DRAWDOWN
}

export async function countOpenPaperPositions(userId: string): Promise<number> {
  return prisma.trade.count({ where: { userId, status: 'OPEN' } })
}

export function validateNewBuy(input: {
  confidence: number
  /** From signal engine (dynamic). Ignored when skipConfidenceCheck is true. */
  minConfidenceRequired: number
  proposedTradeFraction: number
  openCount: number
  openExposureFraction: number
  drawdownHalted: boolean
  /** One-shot startup trade: still enforces positions / exposure / drawdown. */
  skipConfidenceCheck?: boolean
}): RiskCheckReason {
  if (input.drawdownHalted) return 'DRAWDOWN_HALT'
  if (
    !input.skipConfidenceCheck &&
    !checkSignalConfidence(input.confidence, input.minConfidenceRequired)
  )
    return 'LOW_CONFIDENCE'
  if (input.openCount >= RISK.MAX_OPEN_POSITIONS) return 'MAX_POSITIONS'
  if (input.proposedTradeFraction > RISK.MAX_CAPITAL_PER_TRADE + 1e-9) return 'MAX_TRADE_SIZE'
  if (input.openExposureFraction + input.proposedTradeFraction > RISK.MAX_TOTAL_EXPOSURE + 1e-9)
    return 'MAX_EXPOSURE'
  return 'OK'
}
