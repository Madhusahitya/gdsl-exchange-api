/**
 * Auto-exit for OPEN positions in the DEX Jupiter SOL book.
 * Uses Jupiter sell quotes (same venue as entry).
 *
 * Profit-skim mode (default): at take-profit %, sell only the profit slice into
 * USDC and keep the position OPEN at reduced size until stop-loss fires.
 */

import { TradeStatus, prisma } from '@cryptoflow/db'
import { env } from '../../lib/env'
import { estimatedNetRoundTripUsd, SOLANA_DEX_ROUND_TRIP_FEE_USD } from '../../lib/roundTripPnl'
import { logger } from '../../lib/logger'
import { isSolanaWalletEnabled } from '../wallet/solanaPersonalWalletService'
import { executeJupiterSwap, JUPITER_STRATEGY_NAME, reconcileStaleJupiterOpenTrades } from '../dex/jupiterSwapService'
import { quoteJupiterSellUsdPerToken } from '../dex/jupiterMarkService'
import { isJupiterConfigured } from '../dex/jupiterClassicService'
import { getJupiterTradableToken } from '../dex/jupiterTradableRegistry'
import { getJupiterExitSettings } from '../dex/jupiterExitSettingsService'
import { trackJupiterOpenPosition } from '../notifications/positionUpdateService'
import { maybeNotifyJupiterBreakEven, clearBreakEvenAlert } from '../dex/jupiterAlertService'
import { getSocketIo } from '../../lib/realtimeHub'
import { telegramService } from '../notifications/telegramService'
import { logSuperMachineActivity } from '../agents/superMachineService'

const WATCH_INTERVAL_MS = 15_000
const COOLDOWN_MS = 30_000
const SKIM_COOLDOWN_MS = 45_000

const exitCooldown = new Map<string, number>()
const skimCooldown = new Map<string, number>()
const smEnabledCache = new Map<string, { at: number; enabled: boolean }>()
let strategyIdCache: string | null = null

async function isSuperMachineEnabled(userId: string): Promise<boolean> {
  const hit = smEnabledCache.get(userId)
  if (hit && Date.now() - hit.at < 60_000) return hit.enabled
  const row = await prisma.jupiterSuperMachineConfig.findUnique({
    where: { userId },
    select: { enabled: true },
  })
  const enabled = row?.enabled === true
  smEnabledCache.set(userId, { at: Date.now(), enabled })
  return enabled
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

export async function runJupiterOpenPositionWatcher(): Promise<void> {
  if (!env.dexServerAutoExit || !isSolanaWalletEnabled() || !isJupiterConfigured()) return

  try {
    const strategyId = await jupiterStrategyId()
    const openTrades = await prisma.trade.findMany({
      where: { strategyId, status: TradeStatus.OPEN },
      select: {
        id: true,
        userId: true,
        pair: true,
        entryPrice: true,
        allocationUsd: true,
        pnl: true,
        takeProfitPct: true,
        stopLossPct: true,
        trailingStop: true,
        trailingPeak: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 40,
    })

    // Clear ghost OPEN lots (wallet empty) before attempting exits — same idea as BSC watcher.
    const usersSeen = new Set<string>()
    for (const t of openTrades) {
      if (usersSeen.has(t.userId)) continue
      usersSeen.add(t.userId)
      await reconcileStaleJupiterOpenTrades(t.userId).catch(() => 0)
    }

    const stillOpen = await prisma.trade.findMany({
      where: { strategyId, status: TradeStatus.OPEN },
      select: {
        id: true,
        userId: true,
        pair: true,
        entryPrice: true,
        allocationUsd: true,
        pnl: true,
        takeProfitPct: true,
        stopLossPct: true,
        trailingStop: true,
        trailingPeak: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 40,
    })

    for (const t of stillOpen) {
      const last = exitCooldown.get(t.id) ?? 0
      if (Date.now() - last < COOLDOWN_MS) continue

      const baseSymbol = t.pair.split('/')[0]?.toUpperCase() ?? ''
      const entry = Number(t.entryPrice)
      const buyAlloc = Number(t.allocationUsd ?? 0)
      if (!Number.isFinite(entry) || entry <= 0 || buyAlloc <= 0) continue

      const prefs = getJupiterExitSettings(t.userId)
      if (!prefs.enabled) continue

      const lotQty = buyAlloc / entry
      const exitMark = await quoteJupiterSellUsdPerToken(baseSymbol, lotQty)
      if (exitMark == null) continue

      const pct = ((exitMark - entry) / entry) * 100
      // Per-position overrides win over the user's global exit settings — the
      // user can retune TP/SL on a running trade from the dashboard.
      const tp = t.takeProfitPct != null ? Number(t.takeProfitPct) : prefs.takeProfitPct
      const trailingOn = t.trailingStop ?? prefs.trailingStop
      const slBase = t.stopLossPct != null ? Number(t.stopLossPct) : prefs.stopLossPct
      // Once profit has been skimmed off this lot (pnl > 0 while OPEN), protect
      // the banked gain: tighten the stop to near break-even instead of riding
      // the full stop-loss back down.
      const alreadySkimmed = Number(t.pnl ?? 0) > 0
      const sl = alreadySkimmed ? Math.min(slBase, 0.35) : slBase
      const estNetUsd = estimatedNetRoundTripUsd(
        buyAlloc,
        entry,
        exitMark,
        env.dexAutoExitSlippageBps,
        SOLANA_DEX_ROUND_TRIP_FEE_USD,
      )

      // Telegram milestone / digest updates (throttled inside the service).
      trackJupiterOpenPosition(t.id, {
        userId: t.userId,
        symbol: baseSymbol,
        pair: t.pair,
        entryPrice: entry,
        mark: exitMark,
        pnlPct: pct,
        pnlUsd: estNetUsd,
        takeProfitPct: tp,
        stopLossPct: sl,
        trailingStop: trailingOn,
        skimmedUsd: Number(t.pnl ?? 0) > 0 ? Number(t.pnl) : 0,
        openedAt: t.createdAt.getTime(),
      })

      await maybeNotifyJupiterBreakEven({
        tradeId: t.id,
        userId: t.userId,
        pair: t.pair,
        baseSymbol,
        entry,
        exitMark,
        estNetUsd,
        buyAlloc,
        slippageBps: env.dexAutoExitSlippageBps,
      })

      let reason: 'take_profit' | 'profit_skim' | 'stop_loss' | 'trailing_stop' | null = null
      let sellQty = lotQty
      let partialSkim = false

      if (pct >= tp && prefs.profitSkim) {
        // Skim the profit slice and keep the lot open. Never fall through to a
        // full close just because the slice is small — that's what "Sell now" is for.
        const lastSkim = skimCooldown.get(t.id) ?? 0
        if (Date.now() - lastSkim >= SKIM_COOLDOWN_MS) {
          const token = await getJupiterTradableToken(`${baseSymbol}USDT`)
          const factor = 10 ** Math.min(token?.decimals ?? 6, 8)
          const profitUsd = buyAlloc * (pct / 100)
          const skimQty = Math.min(lotQty * 0.4, profitUsd / exitMark)
          sellQty = Math.floor(skimQty * factor) / factor
          if (sellQty > 0 && sellQty < lotQty * 0.9) {
            reason = 'profit_skim'
            partialSkim = true
          }
        }
      } else if (pct >= tp && !prefs.profitSkim) {
        reason = 'take_profit'
      } else if (trailingOn) {
        // Trailing stop v2 — three improvements over the naive "SL% below peak":
        //  1. Activation: the trail only arms after price is trailingActivationPct
        //     above entry, so normal bid/ask noise inside the fee band never
        //     triggers a premature exit.
        //  2. Ratchet peak persisted on the trade row: restarts no longer reset
        //     the floor, and a new position never inherits a stale peak.
        //  3. Break-even lock: once armed, the floor can never sit below
        //     entry + 0.1%, so an armed trail always banks profit.
        const prevPeak = Number(t.trailingPeak ?? 0)
        const peak = Math.max(prevPeak, exitMark)
        if (peak > prevPeak) {
          void prisma.trade
            .update({ where: { id: t.id }, data: { trailingPeak: peak } })
            .catch((err) => logger.debug({ err, tradeId: t.id }, '[jupiterWatcher] trailing peak persist failed'))
        }
        const armed = peak >= entry * (1 + prefs.trailingActivationPct / 100)
        if (armed) {
          const deltaFloor = peak * (1 - prefs.trailingDeltaPct / 100)
          const breakEvenFloor = entry * 1.001
          const trailFloor = Math.max(deltaFloor, breakEvenFloor)
          if (exitMark <= trailFloor && pct > 0) {
            reason = 'trailing_stop'
          }
        }
        // Hard stop-loss still guards the position while the trail is unarmed.
        if (!reason && pct <= -sl) {
          reason = 'stop_loss'
        }
      } else if (pct <= -sl) {
        reason = 'stop_loss'
      }

      if (!reason) continue

      const smActive = await isSuperMachineEnabled(t.userId)

      const exitLabel =
        reason === 'profit_skim'
          ? `💰 Skimming profit on ${baseSymbol} via Jupiter sell (position stays open)`
          : reason === 'take_profit'
            ? `✅ Closing ${baseSymbol} · Jupiter swap → USDC · take-profit +${pct.toFixed(2)}%`
            : reason === 'trailing_stop'
              ? `📉 Trailing exit ${baseSymbol} · Jupiter sell · locked profit`
              : `🛑 Stop-loss ${baseSymbol} · Jupiter sell → USDC · ${pct.toFixed(2)}%`

      if (smActive) {
        logSuperMachineActivity(t.userId, { type: 'exit', message: exitLabel, details: { reason, pct } })
      }

      exitCooldown.set(t.id, Date.now())
      if (reason === 'profit_skim') skimCooldown.set(t.id, Date.now())

      try {
        const result = await executeJupiterSwap(
          t.userId,
          {
            side: 'SELL',
            binanceSymbol: `${baseSymbol}USDT`,
            amount: sellQty,
            slippageBps: env.dexAutoExitSlippageBps,
          },
          { skipEntryGuard: true, partialSkim },
        )
        if (reason !== 'profit_skim') {
          // Trailing peak lives on the trade row and dies with the close — only
          // the break-even alert needs explicit cleanup.
          clearBreakEvenAlert(t.id)
        }
        const io = getSocketIo()
        io?.to(`user:${t.userId}`).emit('trade:executed', {
          source: 'dex-jupiter-auto',
          reason,
          ...result,
        })
        const reasonLabel =
          reason === 'profit_skim'
            ? 'Jupiter profit skim (position still open)'
            : reason === 'take_profit'
              ? 'Jupiter auto take-profit'
              : reason === 'trailing_stop'
                ? 'Jupiter trailing stop'
                : 'Jupiter auto stop-loss'
        void telegramService
          .notifyDexBotTrade({
            userId: t.userId,
            action: 'SELL',
            pair: t.pair,
            reason: reasonLabel,
            fillPriceUsd: result.trade.exitPrice ?? exitMark,
            entryPriceUsd: entry,
            usdtReceived: Number(result.trade.allocationUsd ?? buyAlloc),
            realizedPnlUsd: result.trade.pnl,
            txHash: result.txSignature,
            trigger: 'auto',
            walletLabel: 'Jupiter Super Machine',
          })
          .catch(() => null)
        logger.info(
          { tradeId: t.id, userId: t.userId, reason, pct: pct.toFixed(2), partialSkim },
          '[jupiterWatcher] auto-exit',
        )
        const closed = reason !== 'profit_skim' && result.trade.status === 'CLOSED'
        if (smActive) {
          logSuperMachineActivity(t.userId, {
            type: closed ? 'profit' : 'exit',
            message: closed
              ? `✅ Closed ${baseSymbol} · sold ~$${(result.trade.exitPrice != null ? Number(result.trade.allocationUsd ?? buyAlloc) : buyAlloc).toFixed(2)} · PnL ${result.trade.pnl != null ? (result.trade.pnl >= 0 ? '+' : '') + result.trade.pnl.toFixed(2) : '—'} USDC`
              : `💰 Profit banked on ${baseSymbol} · +$${(result.trade.pnl ?? 0).toFixed(2)} USDC · position still running`,
            details: { signature: result.txSignature, reason },
          })
        }
      } catch (err) {
        logger.warn(
          { err, tradeId: t.id, userId: t.userId },
          '[jupiterWatcher] auto-exit failed',
        )
      }
    }
  } catch (err) {
    logger.error({ err }, '[jupiterWatcher] run failed')
  }
}

export function startJupiterOpenPositionWatcher(): void {
  if (!isJupiterConfigured()) return
  setInterval(() => void runJupiterOpenPositionWatcher(), WATCH_INTERVAL_MS)
  void runJupiterOpenPositionWatcher()
}
