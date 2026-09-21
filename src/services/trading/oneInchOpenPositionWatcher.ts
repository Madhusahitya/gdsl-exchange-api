/**
 * Auto-exit for OPEN positions in the DEX 1inch BSC book.
 * Uses 1inch sell quotes (same venue as entry) — not Binance-only TP.
 */

import { TradeStatus, prisma } from '@cryptoflow/db'
import { env } from '../../lib/env'
import { estimatedNetRoundTripUsd } from '../../lib/roundTripPnl'
import { logger } from '../../lib/logger'
import { isPersonalWalletEnabled } from '../wallet/personalWalletService'
import { executeOneInchSwap } from '../dex/oneInchSwapService'
import { quoteOneInchSellUsdPerToken } from '../dex/oneInchMarkService'
import { isOneInchConfigured } from '../dex/oneInchClassicService'
import { getSocketIo } from '../../lib/realtimeHub'
import { telegramService } from '../notifications/telegramService'

const WATCH_INTERVAL_MS = 30_000
const COOLDOWN_MS = 45_000
const ONEINCH_STRATEGY = 'DEX 1inch BSC'

const exitCooldown = new Map<string, number>()
let strategyIdCache: string | null = null

async function oneInchStrategyId(): Promise<string> {
  if (strategyIdCache) return strategyIdCache
  const s = await prisma.strategy.findFirst({
    where: { name: ONEINCH_STRATEGY },
    select: { id: true },
  })
  if (!s) throw new Error('DEX 1inch BSC strategy missing')
  strategyIdCache = s.id
  return s.id
}

export async function runOneInchOpenPositionWatcher(): Promise<void> {
  if (!env.dexServerAutoExit || !isPersonalWalletEnabled() || !isOneInchConfigured()) return

  try {
    const strategyId = await oneInchStrategyId()
    const openTrades = await prisma.trade.findMany({
      where: { strategyId, status: TradeStatus.OPEN },
      select: {
        id: true,
        userId: true,
        pair: true,
        entryPrice: true,
        allocationUsd: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 40,
    })

    for (const t of openTrades) {
      const last = exitCooldown.get(t.id) ?? 0
      if (Date.now() - last < COOLDOWN_MS) continue

      const baseSymbol = t.pair.split('/')[0]?.toUpperCase() ?? ''
      const entry = Number(t.entryPrice)
      const buyAlloc = Number(t.allocationUsd ?? 0)
      if (!Number.isFinite(entry) || entry <= 0 || buyAlloc <= 0) continue

      const lotQty = buyAlloc / entry
      const exitMark = await quoteOneInchSellUsdPerToken(baseSymbol, lotQty)
      if (exitMark == null) continue

      const pct = ((exitMark - entry) / entry) * 100
      const tp = env.dexAutoTakeProfitPct
      const sl = env.dexAutoStopLossPct
      const estNetUsd = estimatedNetRoundTripUsd(buyAlloc, entry, exitMark, env.dexAutoExitSlippageBps)
      const minNetUsd = env.dexMinNetProfitUsd

      let reason: 'take_profit' | 'stop_loss' | null = null
      if (pct >= tp && estNetUsd >= minNetUsd) reason = 'take_profit'
      else if (pct <= -sl) reason = 'stop_loss'
      if (!reason) continue

      exitCooldown.set(t.id, Date.now())
      try {
        const result = await executeOneInchSwap(t.userId, {
          side: 'SELL',
          binanceSymbol: `${baseSymbol}USDT`,
          amount: lotQty,
          slippageBps: env.dexAutoExitSlippageBps,
        })
        const io = getSocketIo()
        if (io) {
          io.to(`user:${t.userId}`).emit('trade:executed', {
            trade: {
              id: result.trade.id,
              pair: result.trade.pair,
              signal: 'SELL',
              entryPrice: result.trade.entryPrice,
              exitPrice: result.trade.exitPrice,
              pnl: result.trade.pnl,
              status: result.trade.status,
              side: result.trade.side,
            },
            currentPnl: result.trade.pnl ?? 0,
          })
        }
        void telegramService
          .notifyDexBotTrade({
            userId: t.userId,
            action: 'SELL',
            pair: t.pair,
            reason: reason === 'take_profit' ? `1inch TP (+${pct.toFixed(2)}%)` : `1inch SL (${pct.toFixed(2)}%)`,
            fillPriceUsd: result.trade.exitPrice ?? exitMark,
            entryPriceUsd: entry,
            usdtReceived: undefined,
            realizedPnlUsd: result.trade.pnl,
            unrealizedPct: pct,
            txHash: result.txHash,
            trigger: 'auto',
          })
          .catch(() => null)
        logger.info(
          { tradeId: t.id, userId: t.userId, pair: t.pair, reason, pct, txHash: result.txHash },
          '[oneInchWatcher] auto-exit',
        )
      } catch (err) {
        exitCooldown.delete(t.id)
        logger.warn(
          { tradeId: t.id, err: err instanceof Error ? err.message : err },
          '[oneInchWatcher] auto-exit failed',
        )
      }
      await new Promise((r) => setTimeout(r, 300))
    }
  } catch (err) {
    logger.error({ err }, '[oneInchWatcher] run failed')
  }
}

let started = false

export function startOneInchOpenPositionWatcher(): void {
  if (started) return
  started = true
  if (!env.dexServerAutoExit || !isOneInchConfigured()) return
  logger.info('[oneInchWatcher] started (1inch-quoted TP/SL)')
  void runOneInchOpenPositionWatcher()
  setInterval(() => void runOneInchOpenPositionWatcher(), WATCH_INTERVAL_MS)
}
