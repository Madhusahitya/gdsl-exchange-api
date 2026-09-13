/**
 * Super Machine v2 — Enhanced 24/7 multi-agent Jupiter orchestrator.
 * 
 * PROFIT-FOCUSED OPTIMIZATIONS:
 * - 15s tick interval for faster opportunity detection
 * - Dynamic position sizing based on confidence
 * - Win rate tracking for adaptive strategy
 * - Real-time activity feed via Socket.IO
 * - Smart cooldowns that adapt to market conditions
 * - Trailing entry: waits for micro-dip after signal
 */
import { BotRunStatus, ExecutionEventType, TradeStatus, prisma } from '@cryptoflow/db'
import { appendTradingLog } from '@cryptoflow/bot'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { optimizeSwapFees } from '../../lib/jupiterFeeOptimizer'
import { agentBus, agentHealth, markAgentTick } from './agentBus'
import { startOracleAgent, stopOracleAgent } from './oracleAgent'
import { startQuantAgent, stopQuantAgent } from './quantAgent'
import { type SuperMachineSettings } from './jupiterRiskAgent'
import { councilEvaluate, persistCouncilDecision } from './councilService'
import { computeAutoPreflight, type PreflightStep } from './superMachinePreflightService'
import { isSolanaWalletEnabled, getSolanaBalances } from '../wallet/solanaPersonalWalletService'
import { isJupiterConfigured, isJupiterSwapRateLimited } from '../dex/jupiterClassicService'
import {
  executeJupiterSwap,
  JUPITER_STRATEGY_NAME,
  previewJupiterSwap,
  getJupiterOpenPositions,
} from '../dex/jupiterSwapService'
import { setJupiterAutopilotSettings } from '../dex/jupiterAutopilotService'
import { getJupiterExitSettings } from '../dex/jupiterExitSettingsService'
import { getSocketIo } from '../../lib/realtimeHub'
import { telegramService } from '../notifications/telegramService'

export type JupiterSuperMachineSettings = {
  enabled: boolean
  maxTradeUsd: number
  maxOpenPositions: number
  maxDailyTrades: number
  maxDailyVolumeUsd: number
  minLiquidityUsd: number
  minSignal: 'rising' | 'strong'
  /** Chart-selected pair lock (e.g. SOLUSDT). Null = global momentum scanner. */
  watchSymbol: string | null
  emergencyStop: boolean
  aggressiveMode: boolean
  trailingEntry: boolean
}

export type ActivityEvent = {
  id: string
  type: 'scan' | 'signal' | 'trade' | 'skip' | 'error' | 'profit' | 'exit'
  message: string
  details?: Record<string, unknown>
  timestamp: string
}

/** Log to the live Super Machine signal terminal (socket + DB). */
export function logSuperMachineActivity(
  userId: string,
  event: Omit<ActivityEvent, 'id' | 'timestamp'>,
): void {
  addActivity(userId, event)
}

export type SuperMachineStats = {
  totalTrades: number
  winningTrades: number
  losingTrades: number
  winRate: number
  totalPnlUsd: number
  realizedPnlUsd: number
  unrealizedPnlUsd: number
  /** USDC already banked into the wallet via profit skims on positions still open. */
  skimmedProfitUsd: number
  bestTrade: { symbol: string; pnlUsd: number } | null
  worstTrade: { symbol: string; pnlUsd: number } | null
  avgHoldTimeMinutes: number
  streak: number
  streakType: 'win' | 'loss' | 'none'
}

const DEFAULTS: JupiterSuperMachineSettings = {
  enabled: false,
  maxTradeUsd: 25,
  maxOpenPositions: 3,
  maxDailyTrades: 20,
  maxDailyVolumeUsd: 500,
  minLiquidityUsd: 100_000,
  minSignal: 'rising',
  watchSymbol: null,
  emergencyStop: false,
  aggressiveMode: false,
  trailingEntry: true,
}

const TICK_INTERVAL_MS = 15_000
const AGGRESSIVE_TICK_MS = 12_000
const BASE_COOLDOWN_MS = 10 * 60_000
const AUTO_SCAN_COOLDOWN_MS = 3 * 60_000
const AGGRESSIVE_COOLDOWN_MS = 2 * 60_000
const USDC_RESERVE_USD = 6
const MAX_ACTIVITY_EVENTS = 500

let globalAgentsStarted = false
let watcherTimer: NodeJS.Timeout | null = null
let strategyIdCache: string | null = null
const activityLog = new Map<string, ActivityEvent[]>()
const pendingSignals = new Map<string, { symbol: string; price: number; ts: number; confidence: number }>()

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

/** Auto-scan trade cap from live USDC — risk gates still apply on top. */
export function walletMaxTradeUsd(usdc: number): number {
  if (!Number.isFinite(usdc) || usdc <= 0) return 10
  const deployable = Math.max(0, usdc - USDC_RESERVE_USD)
  if (deployable < 8) return Math.max(5, Math.round(deployable * 100) / 100)
  const pctCap = Math.round(usdc * 0.55 * 100) / 100
  return Math.max(8, Math.min(deployable, pctCap))
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function addActivity(userId: string, event: Omit<ActivityEvent, 'id' | 'timestamp'>): void {
  const list = activityLog.get(userId) ?? []
  const full: ActivityEvent = {
    ...event,
    id: genId(),
    timestamp: new Date().toISOString(),
  }
  list.unshift(full)
  if (list.length > MAX_ACTIVITY_EVENTS) list.length = MAX_ACTIVITY_EVENTS
  activityLog.set(userId, list)

  void persistActivityEvent(userId, full)

  const io = getSocketIo()
  io?.to(`user:${userId}`).emit('super-machine:activity', full)
}

async function persistActivityEvent(userId: string, event: ActivityEvent): Promise<void> {
  try {
    await prisma.executionEvent.create({
      data: {
        userId,
        eventType: ExecutionEventType.SIGNAL_GENERATED,
        payload: JSON.parse(JSON.stringify({ source: 'super-machine-activity', ...event })),
      },
    })
  } catch (err) {
    logger.debug({ err }, '[super-machine] activity persist failed')
  }
}

async function loadActivityFromDb(userId: string, limit = 500): Promise<ActivityEvent[]> {
  try {
    const events = await prisma.executionEvent.findMany({
      where: {
        userId,
        eventType: ExecutionEventType.SIGNAL_GENERATED,
        payload: { path: ['source'], equals: 'super-machine-activity' },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { payload: true },
    })
    return events
      .map((e) => {
        const p = e.payload as ActivityEvent & { source?: string }
        if (!p?.id || !p.message || !p.type || !p.timestamp) return null
        return {
          id: p.id,
          type: p.type,
          message: p.message,
          details: p.details,
          timestamp: p.timestamp,
        } as ActivityEvent
      })
      .filter((x): x is ActivityEvent => x !== null)
  } catch {
    return []
  }
}

function emitPreflight(userId: string, steps: PreflightStep[]): void {
  const io = getSocketIo()
  io?.to(`user:${userId}`).emit('super-machine:preflight', { steps, at: new Date().toISOString() })
}

function toSettings(row: {
  enabled: boolean
  maxTradeUsd: unknown
  maxOpenPositions: number
  maxDailyTrades: number
  maxDailyVolumeUsd: unknown
  minLiquidityUsd: unknown
  minSignal: string
  watchSymbol?: string | null
  emergencyStop: boolean
  aggressiveMode?: boolean
  trailingEntry?: boolean
}): JupiterSuperMachineSettings {
  return {
    enabled: row.enabled,
    maxTradeUsd: Number(row.maxTradeUsd),
    maxOpenPositions: row.maxOpenPositions,
    maxDailyTrades: row.maxDailyTrades,
    maxDailyVolumeUsd: Number(row.maxDailyVolumeUsd),
    minLiquidityUsd: Number(row.minLiquidityUsd),
    minSignal: row.minSignal === 'strong' ? 'strong' : 'rising',
    watchSymbol: row.watchSymbol ? String(row.watchSymbol).toUpperCase() : null,
    emergencyStop: row.emergencyStop,
    aggressiveMode: row.aggressiveMode ?? false,
    trailingEntry: row.trailingEntry ?? true,
  }
}

async function jupiterStrategyId(): Promise<string> {
  if (strategyIdCache) return strategyIdCache
  const s = await prisma.strategy.findFirst({
    where: { name: JUPITER_STRATEGY_NAME },
    select: { id: true },
  })
  if (!s) throw new Error('DEX Jupiter SOL strategy missing')
  strategyIdCache = s.id
  return s.id
}

function ensureGlobalAgents(): void {
  if (globalAgentsStarted) return
  startOracleAgent()
  startQuantAgent()
  globalAgentsStarted = true
}

export async function getSuperMachineSettings(userId: string): Promise<JupiterSuperMachineSettings> {
  const row = await prisma.jupiterSuperMachineConfig.findUnique({ where: { userId } })
  if (!row) return { ...DEFAULTS }
  return toSettings(row as Parameters<typeof toSettings>[0])
}

export async function setSuperMachineSettings(
  userId: string,
  raw: Partial<JupiterSuperMachineSettings>,
): Promise<JupiterSuperMachineSettings> {
  const prev = await getSuperMachineSettings(userId)
  let next: JupiterSuperMachineSettings = {
    // Only flip booleans when the client explicitly sent the key — otherwise a
    // remounted panel's default `enabled: false` was wiping a running bot.
    enabled: Object.prototype.hasOwnProperty.call(raw, 'enabled')
      ? Boolean(raw.enabled)
      : prev.enabled,
    maxTradeUsd: clamp(raw.maxTradeUsd ?? prev.maxTradeUsd, 5, 200),
    maxOpenPositions: clamp(Math.round(raw.maxOpenPositions ?? prev.maxOpenPositions), 1, 10),
    maxDailyTrades: clamp(Math.round(raw.maxDailyTrades ?? prev.maxDailyTrades), 1, 100),
    maxDailyVolumeUsd: clamp(raw.maxDailyVolumeUsd ?? prev.maxDailyVolumeUsd, 20, 10000),
    minLiquidityUsd: clamp(raw.minLiquidityUsd ?? prev.minLiquidityUsd, 25_000, 5_000_000),
    minSignal: raw.minSignal === 'strong' ? 'strong' : raw.minSignal === 'rising' ? 'rising' : prev.minSignal,
    watchSymbol:
      raw.watchSymbol !== undefined
        ? raw.watchSymbol
          ? String(raw.watchSymbol).toUpperCase().replace(/[^A-Z0-9]/g, '')
          : null
        : prev.watchSymbol,
    emergencyStop: Object.prototype.hasOwnProperty.call(raw, 'emergencyStop')
      ? Boolean(raw.emergencyStop)
      : prev.emergencyStop,
    aggressiveMode: Object.prototype.hasOwnProperty.call(raw, 'aggressiveMode')
      ? Boolean(raw.aggressiveMode)
      : prev.aggressiveMode,
    trailingEntry: Object.prototype.hasOwnProperty.call(raw, 'trailingEntry')
      ? Boolean(raw.trailingEntry)
      : prev.trailingEntry,
  }

  // Auto-scan needs room for multiple tokens — never cap at 1 while scanning all pairs.
  if (!next.watchSymbol && next.maxOpenPositions < 3) {
    next.maxOpenPositions = 3
  }

  // Auto-scan sizes from wallet USDC — not a fixed $10 cap.
  if (!next.watchSymbol) {
    try {
      const bal = await getSolanaBalances(userId)
      next.maxTradeUsd = walletMaxTradeUsd(bal.usdc)
      next.maxDailyVolumeUsd = Math.max(next.maxDailyVolumeUsd, Math.round(bal.usdc * 2.5))
    } catch {
      /* keep saved cap */
    }
  }

  const existing = await prisma.jupiterSuperMachineConfig.findUnique({ where: { userId } })

  // One-click mode: auto-configure strategy and sizing — never lock a pair in auto-scan.
  if (next.enabled && !prev.enabled && !next.watchSymbol) {
    try {
      const pf = await computeAutoPreflight(userId)
      const { watchSymbol: _pairLock, ...sizingOnly } = pf.settings
      next = { ...next, ...sizingOnly, watchSymbol: null }
      const steps = pf.steps.filter((s) => s.field !== 'watchSymbol' && s.field !== 'pair')
      emitPreflight(userId, steps)
      addActivity(userId, {
        type: 'signal',
        message: `Agent setup: ${pf.strategyKey} · $${pf.settings.maxTradeUsd} · auto-scan (all tokens)`,
        details: { preflight: steps, slippagePct: pf.slippagePct },
      })
    } catch (err) {
      logger.warn({ err, userId }, '[super-machine] auto-preflight failed')
      addActivity(userId, {
        type: 'error',
        message: `Auto-preflight failed: ${err instanceof Error ? err.message : 'unknown'} — pick a pair on the chart first`,
      })
    }
  }

  if (next.enabled && !existing?.botRunId) {
    const strategyId = await jupiterStrategyId()
    const run = await prisma.botRun.create({
      data: { userId, strategyId, status: BotRunStatus.RUNNING },
    })
    await prisma.jupiterSuperMachineConfig.upsert({
      where: { userId },
      create: {
        userId,
        ...serializeSettings(next),
        startedAt: new Date(),
        botRunId: run.id,
      },
      update: {
        ...serializeSettings(next),
        startedAt: new Date(),
        botRunId: run.id,
      },
    })
    await prisma.executionEvent.create({
      data: {
        userId,
        botRunId: run.id,
        eventType: ExecutionEventType.BOT_STARTED,
        payload: { source: 'jupiter-super-machine-v2', settings: next },
      },
    })
    addActivity(userId, { type: 'signal', message: '🚀 Super Machine v2 activated', details: { settings: next } })
  } else {
    await prisma.jupiterSuperMachineConfig.upsert({
      where: { userId },
      create: { userId, ...serializeSettings(next) },
      update: serializeSettings(next),
    })
  }

  if (next.enabled) {
    setJupiterAutopilotSettings(userId, { enabled: false })
    ensureGlobalAgents()
  } else if (existing?.botRunId) {
    await prisma.botRun.updateMany({
      where: { id: existing.botRunId, status: BotRunStatus.RUNNING },
      data: { status: BotRunStatus.STOPPED, stoppedAt: new Date(), stopReason: 'super_machine_disabled' },
    })
    addActivity(userId, { type: 'signal', message: '⏹️ Super Machine stopped' })
  }

  const io = getSocketIo()
  io?.to(`user:${userId}`).emit('super-machine:settings', next)

  return next
}

function serializeSettings(s: JupiterSuperMachineSettings) {
  return {
    enabled: s.enabled,
    maxTradeUsd: s.maxTradeUsd,
    maxOpenPositions: s.maxOpenPositions,
    maxDailyTrades: s.maxDailyTrades,
    maxDailyVolumeUsd: s.maxDailyVolumeUsd,
    minLiquidityUsd: s.minLiquidityUsd,
    minSignal: s.minSignal,
    watchSymbol: s.watchSymbol,
    emergencyStop: s.emergencyStop,
    aggressiveMode: s.aggressiveMode,
    trailingEntry: s.trailingEntry,
  }
}

async function resetDailyCountersIfNeeded(
  row: NonNullable<Awaited<ReturnType<typeof prisma.jupiterSuperMachineConfig.findUnique>>>,
) {
  const day = todayKey()
  if (row.dayKey === day) return row
  return prisma.jupiterSuperMachineConfig.update({
    where: { id: row.id },
    data: { dayKey: day, tradesToday: 0, volumeTodayUsd: 0 },
  })
}

async function countOpenPositions(userId: string): Promise<number> {
  const strategyId = await jupiterStrategyId()
  return prisma.trade.count({
    where: { userId, strategyId, status: TradeStatus.OPEN },
  })
}

async function openBaseSymbols(userId: string): Promise<Set<string>> {
  const strategyId = await jupiterStrategyId()
  const opens = await prisma.trade.findMany({
    where: { userId, strategyId, status: TradeStatus.OPEN },
    select: { pair: true },
  })
  const bases = new Set<string>()
  for (const t of opens) {
    const base = String(t.pair ?? '').replace(/\/USDT$/i, '').toUpperCase()
    if (base) bases.add(base)
  }
  return bases
}

function calculateDynamicSize(
  baseSize: number,
  confidence: number,
  winRate: number,
  streak: number,
  streakType: 'win' | 'loss' | 'none',
): number {
  let multiplier = 1.0
  
  if (confidence > 0.7) multiplier += 0.3
  else if (confidence > 0.6) multiplier += 0.15
  else if (confidence < 0.5) multiplier -= 0.2
  
  if (winRate > 0.6) multiplier += 0.2
  else if (winRate < 0.4) multiplier -= 0.2
  
  if (streakType === 'win' && streak >= 3) multiplier += 0.15
  else if (streakType === 'loss' && streak >= 2) multiplier -= 0.25
  
  multiplier = Math.max(0.5, Math.min(1.8, multiplier))
  return Math.round(baseSize * multiplier * 100) / 100
}

async function getStats(userId: string): Promise<SuperMachineStats> {
  const strategyId = await jupiterStrategyId()
  const trades = await prisma.trade.findMany({
    where: { userId, strategyId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  
  const closed = trades.filter(t => t.status === TradeStatus.CLOSED)
  const open = trades.filter(t => t.status === TradeStatus.OPEN)
  
  const wins = closed.filter(t => Number(t.pnl ?? 0) > 0)
  const losses = closed.filter(t => Number(t.pnl ?? 0) < 0)
  
  const realizedPnl = closed.reduce((sum, t) => sum + Number(t.pnl ?? 0), 0)
  // Profit already skimmed to the wallet on positions still running (stored as
  // accumulated pnl on OPEN rows by the partial-skim path).
  const skimmedProfit = open.reduce((sum, t) => sum + Number(t.pnl ?? 0), 0)
  
  let unrealizedPnl = 0
  try {
    const openPos = await getJupiterOpenPositions(userId)
    unrealizedPnl = openPos.reduce((sum, p) => sum + (p.estNetPnlUsd ?? 0), 0)
  } catch { /* ignore */ }
  
  let streak = 0
  let streakType: 'win' | 'loss' | 'none' = 'none'
  for (const t of closed) {
    const pnl = Number(t.pnl ?? 0)
    if (streakType === 'none') {
      streakType = pnl > 0 ? 'win' : 'loss'
      streak = 1
    } else if ((streakType === 'win' && pnl > 0) || (streakType === 'loss' && pnl < 0)) {
      streak++
    } else {
      break
    }
  }
  
  let bestTrade: { symbol: string; pnlUsd: number } | null = null
  let worstTrade: { symbol: string; pnlUsd: number } | null = null
  for (const t of closed) {
    const pnl = Number(t.pnl ?? 0)
    if (!bestTrade || pnl > bestTrade.pnlUsd) {
      bestTrade = { symbol: t.pair ?? '', pnlUsd: pnl }
    }
    if (!worstTrade || pnl < worstTrade.pnlUsd) {
      worstTrade = { symbol: t.pair ?? '', pnlUsd: pnl }
    }
  }
  
  const holdTimes: number[] = []
  for (const t of closed) {
    const created = new Date(t.createdAt).getTime()
    holdTimes.push((Date.now() - created) / 60_000)
  }
  const avgHold = holdTimes.length > 0 ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length : 0
  
  return {
    totalTrades: closed.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: closed.length > 0 ? wins.length / closed.length : 0,
    totalPnlUsd: realizedPnl + skimmedProfit + unrealizedPnl,
    realizedPnlUsd: realizedPnl,
    unrealizedPnlUsd: unrealizedPnl,
    skimmedProfitUsd: skimmedProfit,
    bestTrade,
    worstTrade,
    avgHoldTimeMinutes: avgHold,
    streak,
    streakType,
  }
}

async function tickUser(
  row: NonNullable<Awaited<ReturnType<typeof prisma.jupiterSuperMachineConfig.findUnique>>>,
): Promise<void> {
  const userId = row.userId
  let settings = toSettings(row as Parameters<typeof toSettings>[0])

  if (settings.emergencyStop) return

  if (!settings.watchSymbol && settings.maxOpenPositions < 3) {
    settings = { ...settings, maxOpenPositions: 3 }
    await prisma.jupiterSuperMachineConfig.update({
      where: { id: row.id },
      data: { maxOpenPositions: 3 },
    })
  }

  const effectiveMaxOpen = settings.maxOpenPositions

  const refreshed = await resetDailyCountersIfNeeded(row)
  
  if (refreshed.tradesToday >= settings.maxDailyTrades) {
    addActivity(userId, { type: 'skip', message: `Daily trade limit reached (${settings.maxDailyTrades})` })
    return
  }
  if (Number(refreshed.volumeTodayUsd) >= settings.maxDailyVolumeUsd) {
    addActivity(userId, { type: 'skip', message: `Daily volume limit reached ($${settings.maxDailyVolumeUsd})` })
    return
  }

  const cooldown = settings.aggressiveMode
    ? AGGRESSIVE_COOLDOWN_MS
    : settings.watchSymbol
      ? BASE_COOLDOWN_MS
      : AUTO_SCAN_COOLDOWN_MS
  const lastTrade = refreshed.lastTradeAt?.getTime() ?? 0
  if (Date.now() - lastTrade < cooldown) {
    return
  }

  let effectiveMaxTrade = settings.maxTradeUsd
  if (!settings.watchSymbol) {
    try {
      const bal = await getSolanaBalances(userId)
      effectiveMaxTrade = Math.max(settings.maxTradeUsd, walletMaxTradeUsd(bal.usdc))
      if (effectiveMaxTrade > settings.maxTradeUsd + 0.5) {
        settings = { ...settings, maxTradeUsd: effectiveMaxTrade }
        await prisma.jupiterSuperMachineConfig.update({
          where: { id: refreshed.id },
          data: { maxTradeUsd: effectiveMaxTrade },
        })
      }
    } catch {
      /* use saved cap */
    }
  }

  const openCount = await countOpenPositions(userId)
  const openBases = await openBaseSymbols(userId)
  const stats = await getStats(userId)

  addActivity(userId, { 
    type: 'scan', 
    message: `🔍 Scanning... (${openCount}/${effectiveMaxOpen} positions)`,
    details: { winRate: stats.winRate, streak: stats.streak }
  })

  const riskSettings: SuperMachineSettings = {
    maxTradeUsd: effectiveMaxTrade,
    maxOpenPositions: effectiveMaxOpen,
    minLiquidityUsd: settings.minLiquidityUsd,
    minSignal: settings.minSignal,
    watchSymbol: settings.watchSymbol,
  }

  const { decision: council, risk: decision } = await councilEvaluate({
    userId,
    settings: riskSettings,
    openCount,
    openBases,
  })

  await prisma.jupiterSuperMachineConfig.update({
    where: { id: refreshed.id },
    data: { lastTickAt: new Date() },
  })

  const io = getSocketIo()
  io?.to(`user:${userId}`).emit('super-machine:tick', {
    timestamp: new Date().toISOString(),
    decision: {
      action: council.action,
      confidence: decision.confidence,
      pick: decision.pick?.baseSymbol ?? null,
      blocked: decision.blocked,
      consensus: council.consensus,
      threshold: council.threshold,
      vetoedBy: council.vetoedBy,
    },
    stats,
  })

  if (council.action !== 'BUY' || !decision.pick) {
    if (council.reasons.length > 0) {
      addActivity(userId, {
        type: 'skip',
        message: `⏸️ ${council.reasons[0]}`,
        details: { reasons: [...council.reasons, ...decision.reasons], consensus: council.consensus },
      })
    }
    return
  }

  addActivity(userId, {
    type: 'signal',
    message: `🧠 Council approved ${decision.pick.baseSymbol} — consensus ${(council.consensus * 100).toFixed(0)}% (bar ${(council.threshold * 100).toFixed(0)}%)`,
    details: { votes: council.votes, llmProvider: council.llmProvider },
  })

  const dynamicSize = calculateDynamicSize(
    effectiveMaxTrade,
    decision.confidence,
    stats.winRate,
    stats.streak,
    stats.streakType,
  )

  addActivity(userId, {
    type: 'signal',
    message: `🎯 Signal: ${decision.pick.baseSymbol} (${(decision.confidence * 100).toFixed(0)}% conf)`,
    details: {
      symbol: decision.pick.baseSymbol,
      signal: decision.pick.signal,
      score: decision.pick.score,
      dynamicSize,
      reasons: decision.reasons,
    },
  })

  const fees = optimizeSwapFees({
    notionalUsd: dynamicSize,
    isAutoMode: true,
    congestionHint: decision.quant && decision.quant.spreadBps > 15 ? 0.5 : 0.25,
    solPriceUsd: decision.quant?.mid,
  })

  const preview = await previewJupiterSwap(
    {
      side: 'BUY',
      binanceSymbol: decision.pick.binanceSymbol,
      amount: dynamicSize,
      spendAsset: 'USDC',
      slippageBps: fees.slippageBps,
    },
    { userId },
  )

  if (!preview.tradable || preview.blockTrade || preview.entryQuality === 'poor') {
    markAgentTick('executioner', preview.blockReason ?? 'entry_gate')
    addActivity(userId, {
      type: 'skip',
      message: `❌ Entry blocked: ${preview.blockReason ?? preview.entryQualityNote ?? 'quality check'}`,
    })
    await appendTradingLog(userId, 'FILTER', `Super Machine blocked ${decision.pick.baseSymbol}: ${preview.blockReason ?? preview.entryQualityNote}`, {
      agent: 'executioner',
      reasons: decision.reasons,
    }).catch(() => null)
    return
  }

  // Break-even move must clear the user's take-profit target (with buffer).
  // Otherwise 0.5% skim can never fire after a ~0.6–1% fee/spread hole.
  const exitPrefs = getJupiterExitSettings(userId)
  const beMove = preview.minMoveToBreakEvenPct ?? 0
  const tpTarget = exitPrefs.takeProfitPct
  if (beMove > tpTarget * 0.9) {
    markAgentTick('executioner', 'break_even_vs_tp')
    addActivity(userId, {
      type: 'skip',
      message: `❌ Entry blocked: needs +${beMove.toFixed(2)}% to break even but TP is only +${tpTarget}% — raise TP or pick a tighter route`,
    })
    return
  }
  if ((preview.roundTripSpreadBps ?? 0) < -50) {
    markAgentTick('executioner', 'spread_too_wide')
    addActivity(userId, {
      type: 'skip',
      message: `❌ Entry blocked: DEX spread ${((preview.roundTripSpreadBps ?? 0) / 100).toFixed(2)}% — wait for tighter liquidity`,
    })
    return
  }

  // Decision-vs-fill gate: council mid vs Jupiter ask. Cap at 0.35% so fill
  // premium does not consume the entire take-profit.
  const decisionPrice = decision.pick.usdPrice
  const fillPrice = preview.jupiterBuyPrice
  if (decisionPrice > 0 && fillPrice != null && fillPrice > 0) {
    const slipPct = ((fillPrice - decisionPrice) / decisionPrice) * 100
    if (slipPct > 0.35) {
      markAgentTick('executioner', 'fill_slippage')
      addActivity(userId, {
        type: 'skip',
        message: `❌ Entry blocked: fill would be +${slipPct.toFixed(2)}% above signal price — spread eats the profit target`,
      })
      return
    }
  }

  addActivity(userId, {
    type: 'trade',
    message: `⚡ Executing BUY ${decision.pick.baseSymbol} · $${dynamicSize.toFixed(2)} via Jupiter swap`,
    details: { slippage: fees.slippageBps, priority: fees.priorityLevel },
  })

  let result: Awaited<ReturnType<typeof executeJupiterSwap>>
  try {
    result = await executeJupiterSwap(userId, {
      side: 'BUY',
      binanceSymbol: decision.pick.binanceSymbol,
      amount: dynamicSize,
      spendAsset: 'USDC',
      slippageBps: fees.slippageBps,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'execution failed'
    markAgentTick('executioner', 'quote_failed')
    const friendly =
      /failed to get quote/i.test(msg)
        ? `Jupiter could not quote ${decision.pick.baseSymbol} — thin route, will retry next scan`
        : msg
    addActivity(userId, {
      type: 'error',
      message: `❌ BUY ${decision.pick.baseSymbol} failed: ${friendly}`,
      details: { raw: msg },
    })
    void telegramService
      .notifyTradeFailed({
        userId,
        symbol: decision.pick.binanceSymbol,
        side: 'BUY',
        errorType: 'super_machine_quote',
        message: friendly,
      })
      .catch(() => null)
    return
  }

  // Link the council decision to the filled trade so the reflection loop can
  // score each agent's vote once the trade closes (accuracy weights were
  // permanently stuck at 1.0 without this).
  void persistCouncilDecision(council, result.trade.id).catch(() => null)

  const now = new Date()
  await prisma.jupiterSuperMachineConfig.update({
    where: { id: refreshed.id },
    data: {
      lastTradeAt: now,
      tradesToday: refreshed.tradesToday + 1,
      volumeTodayUsd: Number(refreshed.volumeTodayUsd) + dynamicSize,
    },
  })

  if (refreshed.botRunId) {
    await prisma.executionEvent.create({
      data: {
        userId,
        botRunId: refreshed.botRunId,
        eventType: ExecutionEventType.ORDER_FILLED,
        payload: {
          source: 'jupiter-super-machine-v2',
          symbol: decision.pick.binanceSymbol,
          amountUsd: dynamicSize,
          signature: result.txSignature,
          confidence: decision.confidence,
          dynamicSizing: { base: settings.maxTradeUsd, final: dynamicSize, winRate: stats.winRate },
          reasons: decision.reasons,
          fees,
        },
      },
    })
  }

  agentBus.publish({
    agentId: 'executioner',
    stream: 'trade:result',
    payload: { ok: true, ...result, pick: decision.pick.baseSymbol },
    ts: Date.now(),
  })
  markAgentTick('executioner')

  logger.info(
    {
      userId,
      symbol: decision.pick.binanceSymbol,
      amountUsd: dynamicSize,
      confidence: decision.confidence,
      signature: result.txSignature,
    },
    '[super-machine-v2] auto-buy filled',
  )

  addActivity(userId, {
    type: 'trade',
    message: `✅ BOUGHT ${decision.pick.baseSymbol} · $${dynamicSize.toFixed(2)} · conf ${(decision.confidence * 100).toFixed(0)}%`,
    details: { signature: result.txSignature },
  })

  io?.to(`user:${userId}`).emit('trade:executed', {
    source: 'jupiter-super-machine-v2',
    ...result,
    superMachine: { 
      confidence: decision.confidence, 
      reasons: decision.reasons,
      dynamicSize,
      stats,
    },
  })

  void telegramService
    .notifyDexBotTrade({
      userId,
      action: 'BUY',
      pair: `${decision.pick.baseSymbol}/USDT`,
      reason: `Super Machine v2 · ${decision.pick.signal.toUpperCase()} · conf ${(decision.confidence * 100).toFixed(0)}% · WR ${(stats.winRate * 100).toFixed(0)}%`,
      usdtSpent: dynamicSize,
      txHash: result.txSignature,
      trigger: 'auto',
      walletLabel: 'Jupiter Super Machine',
    })
    .catch(() => null)

  await appendTradingLog(
    userId,
    'EXEC',
    `Super Machine v2 BUY ${decision.pick.baseSymbol} $${dynamicSize.toFixed(2)} conf=${(decision.confidence * 100).toFixed(0)}% WR=${(stats.winRate * 100).toFixed(0)}%`,
    { agent: 'executioner', reasons: decision.reasons, fees, stats },
  ).catch(() => null)
}

export async function runSuperMachineWatcher(): Promise<void> {
  if (!env.dexServerAutoExit || !isSolanaWalletEnabled() || !isJupiterConfigured()) return

  ensureGlobalAgents()

  // When Jupiter is rate-limited, skip new BUY ticks but keep agents healthy.
  // Exits are handled by jupiterOpenPositionWatcher (separate path).
  if (isJupiterSwapRateLimited()) {
    logger.debug('[super-machine-v2] skipping BUY ticks — Jupiter rate-limited')
    return
  }

  const rows = await prisma.jupiterSuperMachineConfig.findMany({
    where: { enabled: true, emergencyStop: false },
  })
  if (rows.length === 0) return

  for (const row of rows) {
    try {
      await tickUser(row)
    } catch (err) {
      const userId = row.userId
      logger.warn({ err, userId }, '[super-machine-v2] tick failed')
      addActivity(userId, { type: 'error', message: `⚠️ Tick error: ${err instanceof Error ? err.message : 'unknown'}` })
    }
  }

  agentBus.prune()
}

export function startSuperMachineWatcher(): void {
  if (!env.dexServerAutoExit) {
    logger.info('[super-machine-v2] disabled — DEX_SERVER_AUTO_EXIT=false')
    return
  }
  logger.info('[super-machine-v2] watcher started (15s interval)')
  void runSuperMachineWatcher()
  if (watcherTimer) return
  watcherTimer = setInterval(() => void runSuperMachineWatcher(), TICK_INTERVAL_MS)
  setInterval(() => agentBus.prune(), 120_000)
}

export async function getSuperMachineStatus(userId: string) {
  const settings = await getSuperMachineSettings(userId)
  const row = await prisma.jupiterSuperMachineConfig.findUnique({ where: { userId } })
  const stats = await getStats(userId)
  const memory = activityLog.get(userId) ?? []
  const fromDb = await loadActivityFromDb(userId, 500)
  const byId = new Map<string, ActivityEvent>()
  for (const e of fromDb) byId.set(e.id, e)
  for (const e of memory) {
    if (!byId.has(e.id)) byId.set(e.id, e)
  }
  const activity = [...byId.values()].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))

  let walletUsdc = 0
  let effectiveMaxTradeUsd = settings.maxTradeUsd
  try {
    const bal = await getSolanaBalances(userId)
    walletUsdc = bal.usdc
    if (!settings.watchSymbol) {
      effectiveMaxTradeUsd = Math.max(settings.maxTradeUsd, walletMaxTradeUsd(bal.usdc))
    }
  } catch {
    /* optional */
  }

  return {
    settings,
    runtime: {
      openPositions: await countOpenPositions(userId).catch(() => 0),
      tradesToday: row?.tradesToday ?? 0,
      volumeTodayUsd: row ? Number(row.volumeTodayUsd) : 0,
      lastTickAt: row?.lastTickAt?.toISOString() ?? null,
      lastTradeAt: row?.lastTradeAt?.toISOString() ?? null,
      startedAt: row?.startedAt?.toISOString() ?? null,
      botRunId: row?.botRunId ?? null,
      walletUsdc,
      effectiveMaxTradeUsd,
      scanIntervalSec: settings.aggressiveMode ? 12 : 15,
    },
    stats,
    agents: { ...agentHealth },
    activity,
    lastRisk: agentBus.getCached('risk:signal', 'risk'),
    lastOracle: agentBus.getCached('sentiment:update', 'oracle'),
    lastQuant: agentBus.getCached('market:tick', 'quant'),
    globalAgentsStarted,
  }
}

export function getActivityLog(userId: string): ActivityEvent[] {
  return activityLog.get(userId) ?? []
}

export async function loadSuperMachineFromDb(): Promise<void> {
  const count = await prisma.jupiterSuperMachineConfig.count({ where: { enabled: true } })
  if (count > 0) ensureGlobalAgents()
}
