/**
 * Fee optimizer — caps priority fees relative to trade notional so gas never eats profit.
 * Inspired by Jupiter docs + OctoBot-style cost-aware execution.
 */

export type PriorityLevel = 'medium' | 'high' | 'veryHigh'

export type FeeOptimizationInput = {
  notionalUsd: number
  isAutoMode?: boolean
  congestionHint?: number
  solPriceUsd?: number
}

export type FeeOptimizationResult = {
  slippageBps: number
  priorityLevel: PriorityLevel
  maxLamports: number
  dynamicComputeUnitLimit: boolean
  dynamicSlippage: boolean
  maxFeePctOfNotional: number
}

export function optimizeSwapFees(input: FeeOptimizationInput): FeeOptimizationResult {
  const notional = Math.max(1, input.notionalUsd)
  const congestion = Math.min(1, Math.max(0, input.congestionHint ?? 0.3))
  const solPriceUsd = input.solPriceUsd && input.solPriceUsd > 0 ? input.solPriceUsd : 150

  let slippageBps = 30
  if (notional < 10) slippageBps = 50
  else if (notional < 50) slippageBps = 40
  else if (notional >= 200) slippageBps = 25
  if (input.isAutoMode) slippageBps += 5

  const targetFeeUsd = notional * 0.0012
  const lamportsFromUsd = Math.floor((targetFeeUsd / solPriceUsd) * 1_000_000_000)
  const congestionBoost = 1 + congestion * 0.4
  const maxLamports = Math.min(400_000, Math.max(4_000, Math.floor(lamportsFromUsd * congestionBoost)))

  const priorityLevel: PriorityLevel = notional >= 80 || input.isAutoMode ? 'high' : 'medium'
  const maxFeePctOfNotional = ((maxLamports / 1e9) * solPriceUsd) / notional * 100

  return {
    slippageBps,
    priorityLevel,
    maxLamports,
    dynamicComputeUnitLimit: true,
    dynamicSlippage: input.isAutoMode ?? false,
    maxFeePctOfNotional,
  }
}
