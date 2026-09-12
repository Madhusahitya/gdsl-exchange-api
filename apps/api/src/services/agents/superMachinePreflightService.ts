/**
 * Auto-preflight — one-click Super Machine setup from wallet balance + live signals.
 * Picks pair, strategy, size, and slippage when the user enables without manual config.
 */
import { getSolanaBalances } from '../wallet/solanaPersonalWalletService'
import { getJupiterTradeSuggestions } from '../dex/jupiterTrendingService'
import { technicalVote } from './technicalAgent'
import type { JupiterSuperMachineSettings } from './superMachineService'

const MAJOR_BASES = new Set(['SOL', 'BTC', 'ETH', 'WBTC', 'CBBTC', 'JUP', 'RAY', 'BONK', 'WIF'])

export type PreflightStep = {
  id: string
  field: 'watchSymbol' | 'strategy' | 'maxTradeUsd' | 'minSignal' | 'slippagePct' | 'pair'
  value: string | number
  label: string
  reason: string
  delayMs?: number
}

export type AutoPreflightResult = {
  settings: Partial<JupiterSuperMachineSettings>
  steps: PreflightStep[]
  slippagePct: number
  strategyKey: 'safe' | 'trend' | 'momentum'
}

function hasUsableCandles(reason: string): boolean {
  return (
    reason !== 'Candle data unavailable' &&
    !reason.startsWith('Limited candle history —')
  )
}

export async function computeAutoPreflight(userId: string): Promise<AutoPreflightResult> {
  const bal = await getSolanaBalances(userId).catch(() => ({ usdc: 0, totalUsd: 0, sol: 0 }))
  const walletUsd = Math.max(bal.totalUsd, bal.usdc, 0)

  const { items: suggestions } = await getJupiterTradeSuggestions(25)

  type Scored = { sym: string; base: string; signal: string; score: number; techReason: string }
  const scored: Scored[] = []

  for (const item of suggestions.slice(0, 15)) {
    const tech = await technicalVote(item.binanceSymbol)
    if (!hasUsableCandles(tech.reason)) continue

    const majorBonus = MAJOR_BASES.has(item.baseSymbol.toUpperCase()) ? 0.2 : 0
    const solBonus = item.baseSymbol.toUpperCase() === 'SOL' ? 0.15 : 0
    const techBonus = tech.vote === 'BUY' ? 0.15 : tech.vote === 'AVOID' ? -0.25 : 0
    const liqBonus = item.liquidityUsd >= 500_000 ? 0.1 : item.liquidityUsd >= 150_000 ? 0.05 : 0

    scored.push({
      sym: item.binanceSymbol,
      base: item.baseSymbol,
      signal: item.signal,
      score: item.score / 100 + majorBonus + solBonus + techBonus + liqBonus,
      techReason: tech.reason,
    })
  }

  scored.sort((a, b) => b.score - a.score)

  const fallback =
    suggestions.find((s) => s.baseSymbol.toUpperCase() === 'SOL') ?? suggestions[0] ?? null
  const pick = scored[0] ?? (fallback ? { sym: fallback.binanceSymbol, base: fallback.baseSymbol, signal: fallback.signal, score: 0, techReason: '' } : null)

  if (!pick) {
    throw new Error('No tradable token with candle data — wait for Jupiter registry refresh and try again')
  }

  let strategyKey: 'safe' | 'trend' | 'momentum' = 'trend'
  let maxTradeUsd = Math.max(8, Math.min(Math.round(walletUsd * 0.45), Math.round(walletUsd - 5)))
  let minSignal: 'rising' | 'strong' = 'rising'
  let minLiquidityUsd = 150_000
  let maxOpenPositions = 3
  let maxDailyTrades = 12
  let maxDailyVolumeUsd = Math.max(120, Math.round(walletUsd * 2))

  if (walletUsd >= 200) {
    strategyKey = 'momentum'
    maxTradeUsd = Math.min(30, Math.round(walletUsd * 0.1))
    minSignal = 'rising'
    minLiquidityUsd = 150_000
    maxOpenPositions = 3
    maxDailyTrades = 24
    maxDailyVolumeUsd = 500
  } else if (walletUsd >= 75) {
    strategyKey = 'trend'
    maxTradeUsd = Math.min(25, Math.round(walletUsd * 0.12))
    minSignal = 'strong'
    minLiquidityUsd = 250_000
    maxOpenPositions = 2
    maxDailyTrades = 12
    maxDailyVolumeUsd = 300
  }

  const slippagePct =
    pick.base.toUpperCase() === 'SOL' || MAJOR_BASES.has(pick.base.toUpperCase()) ? 0.5 : 1.0

  const strategyLabel =
    strategyKey === 'trend' ? 'Trend Rider' : strategyKey === 'momentum' ? 'Momentum Scalper' : 'Safe Accumulator'

  const steps: PreflightStep[] = [
    {
      id: 'pair',
      field: 'pair',
      value: pick.sym,
      label: `${pick.base}/USDT`,
      reason: `Strongest setup with live candles (${pick.signal} · ${pick.techReason || 'technical OK'})`,
      delayMs: 0,
    },
    {
      id: 'strategy',
      field: 'strategy',
      value: strategyKey,
      label: strategyLabel,
      reason: walletUsd >= 200 ? 'Larger wallet — faster turnover' : walletUsd >= 75 ? 'Balanced risk/reward' : 'Small wallet — balanced entries with room for 3 positions',
      delayMs: 600,
    },
    {
      id: 'maxTrade',
      field: 'maxTradeUsd',
      value: maxTradeUsd,
      label: `$${maxTradeUsd}`,
      reason: `~${Math.round((maxTradeUsd / Math.max(walletUsd, 1)) * 100)}% of $${walletUsd.toFixed(0)} wallet`,
      delayMs: 1200,
    },
    {
      id: 'signal',
      field: 'minSignal',
      value: minSignal,
      label: minSignal === 'strong' ? 'Strong only' : 'Rising+',
      reason: minSignal === 'strong' ? 'Higher conviction entries' : 'More opportunities on momentum',
      delayMs: 1800,
    },
    {
      id: 'slippage',
      field: 'slippagePct',
      value: slippagePct,
      label: `${slippagePct}%`,
      reason: slippagePct <= 0.5 ? 'Major pair — tight slippage' : 'Alt token — wider tolerance',
      delayMs: 2400,
    },
  ]

  return {
    settings: {
      watchSymbol: pick.sym,
      maxTradeUsd,
      minSignal,
      minLiquidityUsd,
      maxOpenPositions,
      maxDailyTrades,
      maxDailyVolumeUsd,
    },
    steps,
    slippagePct,
    strategyKey,
  }
}
