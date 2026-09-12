/**
 * Optional scanner auto-pilot — capped auto-buy on STRONG/RISING momentum picks.
 * Respects smart entry gate, liquidity floor, and max open positions.
 */
import { TradeStatus, prisma } from '@cryptoflow/db'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { isSolanaWalletEnabled } from '../wallet/solanaPersonalWalletService'
import { isJupiterConfigured, isJupiterSwapRateLimited } from './jupiterClassicService'
import { getJupiterTradeSuggestions, type TradeSuggestion } from './jupiterTrendingService'
import { executeJupiterSwap, JUPITER_STRATEGY_NAME, previewJupiterSwap } from './jupiterSwapService'
import { getSocketIo } from '../../lib/realtimeHub'
import { telegramService } from '../notifications/telegramService'

export type JupiterAutopilotSettings = {
  enabled: boolean
  maxBuyUsd: number
  minLiquidityUsd: number
  minSignal: 'rising' | 'strong'
  maxOpenPositions: number
  /** Recurring DCA on a fixed pair (daily / weekly). */
  recurringInterval?: 'daily' | 'weekly' | null
  /** When set with recurring, buys this symbol on interval instead of scanner picks. */
  watchSymbol?: string | null
}

const DEFAULTS: JupiterAutopilotSettings = {
  enabled: false,
  maxBuyUsd: 25,
  minLiquidityUsd: 150_000,
  minSignal: 'rising',
  maxOpenPositions: 1,
  recurringInterval: null,
  watchSymbol: null,
}

const settingsByUser = new Map<string, JupiterAutopilotSettings>()
const enabledUsers = new Set<string>()
const lastBuyAtByUser = new Map<string, number>()
const lastRunLogAtByUser = new Map<string, number>()

const WATCH_INTERVAL_MS = 90_000
const BUY_COOLDOWN_MS = 45 * 60_000
const LOG_THROTTLE_MS = 10 * 60_000

let strategyIdCache: string | null = null

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
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

export function getJupiterAutopilotSettings(userId: string): JupiterAutopilotSettings {
  return settingsByUser.get(userId) ?? { ...DEFAULTS }
}

export function setJupiterAutopilotSettings(
  userId: string,
  raw: Partial<JupiterAutopilotSettings>,
): JupiterAutopilotSettings {
  const prev = getJupiterAutopilotSettings(userId)
  const next: JupiterAutopilotSettings = {
    enabled: raw.enabled ?? prev.enabled,
    maxBuyUsd: clamp(raw.maxBuyUsd ?? prev.maxBuyUsd, 5, 100),
    minLiquidityUsd: clamp(raw.minLiquidityUsd ?? prev.minLiquidityUsd, 50_000, 5_000_000),
    minSignal: raw.minSignal === 'strong' ? 'strong' : 'rising',
    maxOpenPositions: clamp(Math.round(raw.maxOpenPositions ?? prev.maxOpenPositions), 1, 3),
    recurringInterval:
      raw.recurringInterval === 'daily' || raw.recurringInterval === 'weekly'
        ? raw.recurringInterval
        : raw.recurringInterval === null
          ? null
          : prev.recurringInterval ?? null,
    watchSymbol:
      raw.watchSymbol !== undefined
        ? raw.watchSymbol
          ? raw.watchSymbol.toUpperCase().replace(/[^A-Z0-9]/g, '')
          : null
        : prev.watchSymbol ?? null,
  }
  settingsByUser.set(userId, next)
  if (next.enabled) enabledUsers.add(userId)
  else enabledUsers.delete(userId)
  return next
}

function signalRank(s: TradeSuggestion['signal']): number {
  if (s === 'strong') return 2
  if (s === 'rising') return 1
  return 0
}

function pickSuggestion(
  items: TradeSuggestion[],
  settings: JupiterAutopilotSettings,
  openBases: Set<string>,
): TradeSuggestion | null {
  const minRank = settings.minSignal === 'strong' ? 2 : 1
  for (const item of items) {
    if (signalRank(item.signal) < minRank) continue
    if (item.liquidityUsd < settings.minLiquidityUsd) continue
    if (openBases.has(item.baseSymbol.toUpperCase())) continue
    return item
  }
  return null
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

async function tryAutopilotBuy(userId: string): Promise<void> {
  const settings = getJupiterAutopilotSettings(userId)
  if (!settings.enabled) return

  const intervalMs =
    settings.recurringInterval === 'weekly'
      ? 7 * 24 * 60 * 60_000
      : settings.recurringInterval === 'daily'
        ? 24 * 60 * 60_000
        : BUY_COOLDOWN_MS
  const lastBuy = lastBuyAtByUser.get(userId) ?? 0
  if (Date.now() - lastBuy < intervalMs) return

  const openCount = await countOpenPositions(userId)
  if (openCount >= settings.maxOpenPositions) return

  let pickSymbol: string | null = null
  if (settings.watchSymbol && settings.recurringInterval) {
    pickSymbol = settings.watchSymbol.includes('USDT')
      ? settings.watchSymbol
      : `${settings.watchSymbol}USDT`
  } else {
    const { items } = await getJupiterTradeSuggestions(12)
    const openBases = await openBaseSymbols(userId)
    const pick = pickSuggestion(items, settings, openBases)
    if (!pick) return
    pickSymbol = pick.binanceSymbol
  }
  if (!pickSymbol) return

  const preview = await previewJupiterSwap(
    {
      side: 'BUY',
      binanceSymbol: pickSymbol,
      amount: settings.maxBuyUsd,
      spendAsset: 'USDC',
      slippageBps: 100,
    },
    { userId },
  )

  if (!preview.tradable || preview.blockTrade || preview.entryQuality === 'poor') {
    const lastLog = lastRunLogAtByUser.get(userId) ?? 0
    if (Date.now() - lastLog > LOG_THROTTLE_MS) {
      logger.info(
        {
          userId,
          symbol: pickSymbol,
          reason: preview.blockReason ?? preview.entryQualityNote ?? 'entry gate',
        },
        '[jupiter-autopilot] skipped — entry gate',
      )
      lastRunLogAtByUser.set(userId, Date.now())
    }
    return
  }

  const result = await executeJupiterSwap(userId, {
    side: 'BUY',
    binanceSymbol: pickSymbol,
    amount: settings.maxBuyUsd,
    spendAsset: 'USDC',
    slippageBps: 100,
  })

  lastBuyAtByUser.set(userId, Date.now())

  logger.info(
    {
      userId,
      symbol: pickSymbol,
      amountUsd: settings.maxBuyUsd,
      recurring: settings.recurringInterval ?? 'scanner',
      signature: result.txSignature,
    },
    '[jupiter-autopilot] auto-buy filled',
  )

  const baseSymbol = pickSymbol.replace(/USDT$/i, '')
  const io = getSocketIo()
  io?.to(`user:${userId}`).emit('trade:executed', {
    source: 'jupiter-autopilot',
    ...result,
    autopilot: {
      signal: settings.recurringInterval ? settings.recurringInterval : 'scanner',
      amountUsd: settings.maxBuyUsd,
    },
  })

  void telegramService
    .notifyDexBotTrade({
      userId,
      action: 'BUY',
      pair: `${baseSymbol}/USDT`,
      reason: settings.recurringInterval
        ? `Recurring ${settings.recurringInterval} · $${settings.maxBuyUsd} USDC`
        : `Auto-pilot scanner · $${settings.maxBuyUsd} USDC`,
      usdtSpent: settings.maxBuyUsd,
      txHash: result.txSignature,
      trigger: 'auto',
      walletLabel: 'Jupiter Auto-pilot',
    })
    .catch(() => null)
}

export async function runJupiterAutopilotWatcher(): Promise<void> {
  if (!env.dexServerAutoExit || !isSolanaWalletEnabled() || !isJupiterConfigured()) return
  if (isJupiterSwapRateLimited()) return
  if (enabledUsers.size === 0) return

  for (const userId of [...enabledUsers]) {
    try {
      await tryAutopilotBuy(userId)
    } catch (err) {
      logger.warn({ err, userId }, '[jupiter-autopilot] tick failed')
    }
  }
}

export function startJupiterAutopilotWatcher(): void {
  if (!env.dexServerAutoExit) {
    logger.info('[jupiter-autopilot] disabled — DEX_SERVER_AUTO_EXIT=false')
    return
  }
  logger.info('[jupiter-autopilot] watcher started (90s interval)')
  void runJupiterAutopilotWatcher()
  setInterval(() => void runJupiterAutopilotWatcher(), WATCH_INTERVAL_MS)
}
