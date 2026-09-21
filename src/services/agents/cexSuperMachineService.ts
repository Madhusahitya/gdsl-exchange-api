/**
 * Binance CEX Super Machine — council-gated auto trading on spot majors.
 *
 * Parallel to Jupiter Super Machine (Solana). Does NOT modify Jupiter paths.
 * Later both machines feed a cross-venue Deploy $X ranker.
 *
 * Config and the open lot live in `CexSuperMachineConfig`. They used to be
 * process-local Maps, which meant a redeploy left a real Binance position with
 * no take-profit or stop-loss attached to it.
 */
import { appendTradingLog } from '@cryptoflow/bot'
import { ExecutionEventType, OrderSide, OrderType, prisma } from '@cryptoflow/db'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { decryptSecret } from '../../lib/crypto'
import { getSocketIo } from '../../lib/realtimeHub'
import { binanceSpotAdapter } from '../exchange/binanceSpotAdapter'
import { freeAsset, sumQuoteStables } from '../exchange/binanceBalanceHelpers'
import { placeOrder } from '../orders/orderService'
import { fetchBookTicker } from '../trading/binanceSpotQuoteService'
import { getCexExitSettings } from '../exchange/cexExitSettingsService'
import { trackCexOpenPosition, clearCexPositionTracking } from '../notifications/positionUpdateService'
import { telegramService } from '../notifications/telegramService'
import { cexCouncilEvaluate, getRecentCexCouncilDecisions } from './cexCouncilService'
import { computeAutomationReadiness } from '../risk/readiness'

function pairFromCexSymbol(symbol: string): string {
  const base = symbol.replace(/USDT$|USDC$/i, '').toUpperCase()
  if (symbol.endsWith('USDC')) return `${base}/USDC`
  return `${base}/USDT`
}

export type CexSuperMachineSettings = {
  enabled: boolean
  exchangeConnectionId: string | null
  watchSymbol: string
  maxTradeUsd: number
  emergencyStop: boolean
}

export type CexOpenLong = {
  symbol: string
  pair: string
  entryPrice: number
  baseQty: number
  quoteSpent: number
  openedAt: number
  /** USDT profit banked via manual skims while this lot stays open. */
  skimmedUsd: number
  /** Per-position exit overrides — null inherits the global CexExitConfig. */
  takeProfitPct: number | null
  stopLossPct: number | null
  trailingStop: boolean | null
  trailingPeak: number | null
}

const DEFAULTS: CexSuperMachineSettings = {
  enabled: false,
  exchangeConnectionId: null,
  watchSymbol: 'BTCUSDT',
  maxTradeUsd: 25,
  emergencyStop: false,
}

const TICK_MS = 20_000
const BUY_COOLDOWN_MS = 8 * 60_000
/** Below this fraction of the booked lot the wallet is treated as flat. */
const GHOST_LOT_FRACTION = 0.05

let watcher: NodeJS.Timeout | null = null

type ConfigRow = NonNullable<Awaited<ReturnType<typeof prisma.cexSuperMachineConfig.findUnique>>>

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

function toSettings(row: ConfigRow | null): CexSuperMachineSettings {
  if (!row) return { ...DEFAULTS }
  return {
    enabled: row.enabled,
    exchangeConnectionId: row.exchangeConnectionId,
    watchSymbol: row.watchSymbol,
    maxTradeUsd: Number(row.maxTradeUsd),
    emergencyStop: row.emergencyStop,
  }
}

function toOpenLong(row: ConfigRow | null): CexOpenLong | null {
  if (!row?.openSymbol || row.openBaseQty == null || row.openEntryPrice == null) return null
  const baseQty = Number(row.openBaseQty)
  const entryPrice = Number(row.openEntryPrice)
  if (!(baseQty > 0) || !(entryPrice > 0)) return null
  return {
    symbol: row.openSymbol,
    pair: row.openPair ?? pairFromCexSymbol(row.openSymbol),
    entryPrice,
    baseQty,
    quoteSpent: Number(row.openQuoteSpent ?? 0),
    openedAt: (row.openedAt ?? row.updatedAt).getTime(),
    skimmedUsd: Number(row.openSkimmedUsd ?? 0),
    takeProfitPct: row.openTakeProfitPct != null ? Number(row.openTakeProfitPct) : null,
    stopLossPct: row.openStopLossPct != null ? Number(row.openStopLossPct) : null,
    trailingStop: row.openTrailingStop ?? null,
    trailingPeak: row.openTrailingPeak != null ? Number(row.openTrailingPeak) : null,
  }
}

const CLEAR_OPEN_LOT = {
  openSymbol: null,
  openPair: null,
  openEntryPrice: null,
  openBaseQty: null,
  openQuoteSpent: null,
  openedAt: null,
  openTakeProfitPct: null,
  openStopLossPct: null,
  openTrailingStop: null,
  openTrailingPeak: null,
  openSkimmedUsd: null,
} as const

export async function getCexSuperMachineSettings(userId: string): Promise<CexSuperMachineSettings> {
  const row = await prisma.cexSuperMachineConfig.findUnique({ where: { userId } })
  return toSettings(row)
}

export async function setCexSuperMachineSettings(
  userId: string,
  raw: Partial<CexSuperMachineSettings>,
): Promise<CexSuperMachineSettings> {
  const prev = await getCexSuperMachineSettings(userId)
  const next: CexSuperMachineSettings = {
    enabled: raw.enabled ?? prev.enabled,
    exchangeConnectionId:
      raw.exchangeConnectionId !== undefined ? raw.exchangeConnectionId : prev.exchangeConnectionId,
    watchSymbol: (raw.watchSymbol ?? prev.watchSymbol).replace('/', '').toUpperCase(),
    maxTradeUsd: clamp(raw.maxTradeUsd ?? prev.maxTradeUsd, 5, env.CEX_LIVE_MAX_ORDER_USDT),
    emergencyStop: raw.emergencyStop ?? prev.emergencyStop,
  }

  await prisma.cexSuperMachineConfig.upsert({
    where: { userId },
    create: { userId, ...next },
    update: next,
  })

  void prisma.executionEvent
    .create({
      data: {
        userId,
        eventType: ExecutionEventType.BOT_STARTED,
        payload: {
          source: 'binance-cex-super-machine',
          action: next.enabled ? 'enable' : 'configure',
          settings: next,
        },
      },
    })
    .catch(() => null)
  return next
}

export async function getCexSuperMachineStatus(userId: string) {
  const row = await prisma.cexSuperMachineConfig.findUnique({ where: { userId } })
  const settings = toSettings(row)
  const open = toOpenLong(row)
  const [readiness, exit] = await Promise.all([
    computeAutomationReadiness(userId, settings.exchangeConnectionId ?? undefined),
    getCexExitSettings(userId),
  ])
  const decisions = getRecentCexCouncilDecisions(userId, 12)

  // Live mark + PnL so the terminal can render the position card with Skim/TP-SL.
  let openPosition = null as
    | (CexOpenLong & {
        markPrice: number | null
        pnlPct: number | null
        pnlUsd: number | null
        effectiveTakeProfitPct: number
        effectiveStopLossPct: number
        effectiveTrailingStop: boolean
        effectiveProfitSkim: boolean
        /** USDT a Skim would bank right now (0 when blocked). */
        skimmableUsd: number
        /** Why Skim is unavailable right now, or null when it can run. */
        skimBlockedReason: string | null
        /** Whole lot is under Binance's $5 minimum — no sell (skim / TP / SL / Sell now) can execute. */
        belowMinOrder: boolean
        minSellNotionalUsd: number
      })
    | null
  if (open) {
    const book = await fetchBookTicker(open.symbol).catch(() => null)
    const markPrice = book?.bid ?? book?.mid ?? null
    const pnlPct = markPrice != null && open.entryPrice > 0 ? ((markPrice - open.entryPrice) / open.entryPrice) * 100 : null
    const slice = markPrice != null ? computeCexSkimSlice(open, markPrice) : null
    openPosition = {
      ...open,
      markPrice,
      pnlPct,
      pnlUsd: markPrice != null ? (markPrice - open.entryPrice) * open.baseQty : null,
      effectiveTakeProfitPct: open.takeProfitPct ?? exit.takeProfitPct,
      effectiveStopLossPct: open.stopLossPct ?? exit.stopLossPct,
      effectiveTrailingStop: open.trailingStop ?? exit.trailingStop,
      effectiveProfitSkim: exit.profitSkim,
      skimmableUsd: slice && !slice.blockedReason ? slice.skimNotionalUsd : 0,
      skimBlockedReason: slice ? slice.blockedReason : 'No live Binance price right now',
      belowMinOrder: slice ? slice.lotNotionalUsd < CEX_MIN_SELL_NOTIONAL_USD : false,
      minSellNotionalUsd: CEX_MIN_SELL_NOTIONAL_USD,
    }
  }

  return {
    venue: 'binance-cex' as const,
    adapter: binanceSpotAdapter.describe(),
    settings,
    running: settings.enabled && !settings.emergencyStop && readiness.ready,
    readiness,
    openPosition,
    lastDecisions: decisions,
    exit,
    lastTickAt: row?.lastTickAt ?? null,
    note: 'CEX Super Machine uses AI council on Binance spot. Jupiter Super Machine remains separate on Solana.',
  }
}

/**
 * Per-position exit overrides on the running Auto Binance lot — null clears the
 * override so the lot falls back to the user's global CexExitConfig.
 */
export async function setCexPositionExitOverrides(
  userId: string,
  overrides: { takeProfitPct?: number | null; stopLossPct?: number | null; trailingStop?: boolean | null },
): Promise<{ updated: boolean }> {
  const row = await prisma.cexSuperMachineConfig.findUnique({ where: { userId } })
  if (!row?.openSymbol) return { updated: false }

  const data: {
    openTakeProfitPct?: number | null
    openStopLossPct?: number | null
    openTrailingStop?: boolean | null
  } = {}
  if (overrides.takeProfitPct !== undefined) data.openTakeProfitPct = overrides.takeProfitPct
  if (overrides.stopLossPct !== undefined) data.openStopLossPct = overrides.stopLossPct
  if (overrides.trailingStop !== undefined) data.openTrailingStop = overrides.trailingStop
  if (Object.keys(data).length === 0) return { updated: true }

  await prisma.cexSuperMachineConfig.update({ where: { userId }, data })
  logger.info({ userId, overrides: data }, '[cex-sm] position exit overrides set')
  return { updated: true }
}

/** Binance spot minNotional is $5 on the majors; keep a small buffer for price drift. */
export const CEX_MIN_SELL_NOTIONAL_USD = 5.5
const CEX_SKIM_COOLDOWN_MS = 45_000
const skimCooldownByUser = new Map<string, number>()

export type CexSkimSlice = {
  pnlPct: number
  /** Base quantity the skim would sell (0 when blocked). */
  skimQty: number
  /** USDT the skim would bank (≈ unrealized profit, capped at half the lot). */
  skimNotionalUsd: number
  /** Whole-lot notional at the current mark — under $5 nothing can be sold on Binance. */
  lotNotionalUsd: number
  /** Human-readable reason the skim cannot run right now, or null when it can. */
  blockedReason: string | null
}

/**
 * Profit slice we can sell while keeping the runner: sized to the unrealized
 * gain, capped at 50% of the lot, and checked against Binance's minimum order.
 * Shared by the manual Skim button, the auto profit-skim at TP, and the status
 * endpoint (so the UI can explain a disabled button).
 */
export function computeCexSkimSlice(open: CexOpenLong, mark: number, freeBase?: number): CexSkimSlice {
  const pnlPct = open.entryPrice > 0 ? ((mark - open.entryPrice) / open.entryPrice) * 100 : 0
  const lotNotionalUsd = open.baseQty * mark
  const base = { pnlPct, skimQty: 0, skimNotionalUsd: 0, lotNotionalUsd }
  if (pnlPct <= 0.05) return { ...base, blockedReason: 'Not in profit yet' }

  const profitUsd = open.quoteSpent * (pnlPct / 100)
  let skimQty = Math.min(open.baseQty * 0.5, profitUsd / mark)
  if (freeBase != null && freeBase > 0) skimQty = Math.min(skimQty, freeBase * 0.98)
  if (skimQty <= 0 || skimQty >= open.baseQty * 0.9) {
    return { ...base, blockedReason: 'Profit slice is too small to skim yet' }
  }
  const skimNotionalUsd = skimQty * mark
  if (skimNotionalUsd < CEX_MIN_SELL_NOTIONAL_USD) {
    return {
      ...base,
      skimNotionalUsd,
      blockedReason: `Profit slice ~$${skimNotionalUsd.toFixed(2)} is under Binance's $5 minimum order`,
    }
  }
  return { pnlPct, skimQty, skimNotionalUsd, lotNotionalUsd, blockedReason: null }
}

/**
 * Manual profit skim on the Auto Binance lot — sells the profit slice into USDT
 * via a Binance market order and keeps the rest running under its TP/SL.
 */
export async function skimCexPositionProfit(userId: string): Promise<{
  pair: string
  soldQty: number
  markPrice: number
  pnlPct: number
  skimmedUsdTotal: number
}> {
  const row = await prisma.cexSuperMachineConfig.findUnique({ where: { userId } })
  const open = toOpenLong(row)
  if (!open) throw new Error('No open Binance position to skim')

  const connId = await resolveConnectionId(userId, row?.exchangeConnectionId ?? null)
  if (!connId) throw new Error('No trade-only Binance connection linked')

  const conn = await prisma.exchangeConnection.findFirst({ where: { id: connId, userId } })
  if (!conn) throw new Error('Binance connection not found')

  const book = await fetchBookTicker(open.symbol)
  const mark = book?.bid ?? book?.mid
  if (mark == null || mark <= 0) throw new Error('No live Binance price right now — try again in a few seconds')

  const balances = await binanceSpotAdapter.getBalances(
    decryptSecret(conn.encryptedApiKey),
    decryptSecret(conn.encryptedSecret),
  )
  const freeBase = freeAsset(balances, open.symbol.replace(/USDT$|USDC$/i, ''))
  const slice = computeCexSkimSlice(open, mark, freeBase)
  const { pnlPct, skimQty } = slice
  if (slice.blockedReason) {
    throw new Error(
      slice.pnlPct <= 0.05
        ? `${open.pair} is not in profit yet (${pnlPct.toFixed(2)}% vs entry) — nothing to skim`
        : `${slice.blockedReason}. Let profit grow or close the position instead.`,
    )
  }

  const filled = await placeOrder({
    userId,
    exchangeConnectionId: connId,
    symbol: open.symbol,
    side: OrderSide.SELL,
    type: OrderType.MARKET,
    quantity: skimQty,
    price: mark,
  })

  const soldQty = Number(filled.filledQuantity ?? 0) || skimQty
  const fillPrice = Number(filled.avgFillPrice ?? 0) > 0 ? Number(filled.avgFillPrice) : mark
  const fraction = Math.min(0.95, soldQty / open.baseQty)
  const remainingQty = Math.max(0, open.baseQty - soldQty)
  const remainingSpent = Math.max(0, open.quoteSpent * (1 - fraction))
  const realized = (fillPrice - open.entryPrice) * soldQty
  const skimmedTotal = open.skimmedUsd + realized

  await prisma.cexSuperMachineConfig.update({
    where: { userId },
    data: {
      openBaseQty: remainingQty,
      openQuoteSpent: remainingSpent,
      openSkimmedUsd: skimmedTotal,
    },
  })

  await appendTradingLog(
    userId,
    'EXEC',
    `[cex-sm] Manual skim ${open.pair} +$${realized.toFixed(2)} — position still running`,
    { source: 'binance-cex-super-machine', soldQty, fillPrice, pnlPct },
  )
  void telegramService
    .notifyDexBotTrade({
      userId,
      action: 'SELL',
      pair: open.pair,
      reason: 'Binance manual profit skim (position still open)',
      fillPriceUsd: fillPrice,
      entryPriceUsd: open.entryPrice,
      realizedPnlUsd: realized,
      trigger: 'manual',
      walletLabel: 'Binance',
    })
    .catch(() => null)
  getSocketIo()?.to(`user:${userId}`).emit('cex-sm:trade', { side: 'SELL', pair: open.pair, skim: true })

  logger.info({ userId, pair: open.pair, soldQty, pnlPct: pnlPct.toFixed(2) }, '[cex-sm] manual profit skim executed')
  return { pair: open.pair, soldQty, markPrice: fillPrice, pnlPct, skimmedUsdTotal: skimmedTotal }
}

async function resolveConnectionId(userId: string, preferred: string | null): Promise<string | null> {
  if (preferred) {
    const c = await prisma.exchangeConnection.findFirst({
      where: { id: preferred, userId, isActive: true, canTrade: true, canWithdraw: false },
    })
    if (c) return c.id
  }
  const any = await prisma.exchangeConnection.findFirst({
    where: { userId, isActive: true, canTrade: true, canWithdraw: false, exchange: 'BINANCE' },
    orderBy: { updatedAt: 'desc' },
  })
  return any?.id ?? null
}

async function tickUser(row: ConfigRow): Promise<void> {
  const userId = row.userId
  const settings = toSettings(row)
  if (!settings.enabled || settings.emergencyStop || !env.LIVE_AUTOMATION_ENABLED) return

  const connId = await resolveConnectionId(userId, settings.exchangeConnectionId)
  if (!connId) {
    await appendTradingLog(userId, 'SYSTEM', '[cex-sm] No trade-only Binance connection')
    return
  }
  if (settings.exchangeConnectionId !== connId) {
    await prisma.cexSuperMachineConfig.update({
      where: { userId },
      data: { exchangeConnectionId: connId },
    })
  }

  const readiness = await computeAutomationReadiness(userId, connId)
  if (!readiness.ready) return

  const conn = await prisma.exchangeConnection.findFirst({ where: { id: connId, userId } })
  if (!conn) return

  const balances = await binanceSpotAdapter.getBalances(
    decryptSecret(conn.encryptedApiKey),
    decryptSecret(conn.encryptedSecret),
  )
  const freeQuoteUsd = sumQuoteStables(balances)

  await prisma.cexSuperMachineConfig.update({
    where: { userId },
    data: { lastTickAt: new Date() },
  })

  let open = toOpenLong(row)
  const symbol = settings.watchSymbol
  const pair = `${symbol.replace(/USDT$/, '')}/USDT`

  // Manage open long with TP/SL (same prefs as live bot)
  if (open) {
    const baseAsset = open.symbol.replace(/USDT$/, '')
    const freeBase = freeAsset(balances, baseAsset)

    // The coin can leave the account without us knowing: a manual sell on
    // Binance, or a fill we recorded but never completed. Don't keep marking a
    // position we no longer hold.
    if (freeBase < open.baseQty * GHOST_LOT_FRACTION) {
      await prisma.cexSuperMachineConfig.update({ where: { userId }, data: CLEAR_OPEN_LOT })
      clearCexPositionTracking(userId)
      await appendTradingLog(
        userId,
        'SYSTEM',
        `[cex-sm] Cleared stale ${open.pair} lot — no ${baseAsset} balance on Binance`,
        { source: 'binance-cex-super-machine', freeBase, bookedQty: open.baseQty },
      )
      logger.info({ userId, symbol: open.symbol, freeBase, bookedQty: open.baseQty }, '[cex-sm] cleared stale lot')
      open = null
    } else {
      const book = await fetchBookTicker(open.symbol)
      const mark = book?.bid ?? book?.mid
      if (mark != null && open.entryPrice > 0) {
        const exit = await getCexExitSettings(userId)
        const pnlPct = ((mark - open.entryPrice) / open.entryPrice) * 100

        // Per-position overrides win over the global CexExitConfig — the user can
        // retune TP/SL on a running position from the Auto Binance terminal.
        const tp = open.takeProfitPct ?? exit.takeProfitPct
        const trailingOn = open.trailingStop ?? exit.trailingStop
        const slBase = open.stopLossPct ?? exit.stopLossPct
        // After a skim, protect the banked gain with a near-break-even stop.
        const sl = open.skimmedUsd > 0 ? Math.min(slBase, 0.35) : slBase

        // Telegram milestone / digest updates (throttled inside the service).
        trackCexOpenPosition({
          userId,
          symbol: open.symbol,
          pair: open.pair,
          entryPrice: open.entryPrice,
          mark,
          pnlPct,
          pnlUsd: (mark - open.entryPrice) * open.baseQty,
          takeProfitPct: tp,
          stopLossPct: sl,
          trailingStop: trailingOn,
          skimmedUsd: open.skimmedUsd,
          openedAt: open.openedAt,
        })

        let reason: 'take_profit' | 'profit_skim' | 'stop_loss' | 'trailing_stop' | null = null
        let skimSlice: CexSkimSlice | null = null
        if (exit.enabled) {
          if (pnlPct >= tp) {
            // Profit skim (parity with Jupiter): at TP sell only the profit slice
            // and keep the runner. Falls back to a full take-profit close when the
            // slice is under Binance's minimum order or a skim just ran.
            if (exit.profitSkim) {
              const lastSkim = skimCooldownByUser.get(userId) ?? 0
              const slice = computeCexSkimSlice(open, mark, freeBase)
              if (Date.now() - lastSkim >= CEX_SKIM_COOLDOWN_MS && !slice.blockedReason) {
                reason = 'profit_skim'
                skimSlice = slice
              }
            }
            if (!reason) reason = 'take_profit'
          } else if (trailingOn) {
            // Trailing stop v2 (same math as the Jupiter watcher):
            //  1. Arms only after +trailingActivationPct above entry.
            //  2. Peak ratchets up and is persisted on the config row.
            //  3. Floor never drops below entry + 0.1% once armed.
            const prevPeak = open.trailingPeak ?? 0
            const peak = Math.max(prevPeak, mark)
            if (peak > prevPeak) {
              void prisma.cexSuperMachineConfig
                .update({ where: { userId }, data: { openTrailingPeak: peak } })
                .catch((err) => logger.debug({ err, userId }, '[cex-sm] trailing peak persist failed'))
            }
            const armed = peak >= open.entryPrice * (1 + exit.trailingActivationPct / 100)
            if (armed) {
              const trailFloor = Math.max(
                peak * (1 - exit.trailingDeltaPct / 100),
                open.entryPrice * 1.001,
              )
              if (mark <= trailFloor && pnlPct > 0) reason = 'trailing_stop'
            }
            if (!reason && pnlPct <= -sl) reason = 'stop_loss'
          } else if (pnlPct <= -sl) {
            reason = 'stop_loss'
          }
        }

        if (reason === 'profit_skim' && skimSlice) {
          skimCooldownByUser.set(userId, Date.now())
          try {
            const filled = await placeOrder({
              userId,
              exchangeConnectionId: connId,
              symbol: open.symbol,
              side: OrderSide.SELL,
              type: OrderType.MARKET,
              quantity: skimSlice.skimQty,
              price: mark,
            })
            const soldQty = Number(filled.filledQuantity ?? 0) || skimSlice.skimQty
            const fillPrice = Number(filled.avgFillPrice ?? 0) > 0 ? Number(filled.avgFillPrice) : mark
            const fraction = Math.min(0.95, soldQty / open.baseQty)
            const realized = (fillPrice - open.entryPrice) * soldQty
            const skimmedTotal = open.skimmedUsd + realized
            // Lot stays open with the remaining quantity; SL tightens to ~break-even next tick.
            await prisma.cexSuperMachineConfig.update({
              where: { userId },
              data: {
                openBaseQty: Math.max(0, open.baseQty - soldQty),
                openQuoteSpent: Math.max(0, open.quoteSpent * (1 - fraction)),
                openSkimmedUsd: skimmedTotal,
              },
            })
            await appendTradingLog(
              userId,
              'EXEC',
              `[cex-sm] Profit skim ${open.pair} +$${realized.toFixed(2)} at +${pnlPct.toFixed(2)}% — position still running`,
              { source: 'binance-cex-super-machine', reason, soldQty, fillPrice, pnlPct, skimmedTotal },
            )
            void telegramService
              .notifyDexBotTrade({
                userId,
                action: 'SELL',
                pair: open.pair,
                reason: 'Binance profit skim (position still open)',
                fillPriceUsd: fillPrice,
                entryPriceUsd: open.entryPrice,
                realizedPnlUsd: realized,
                trigger: 'auto',
                walletLabel: 'Binance',
              })
              .catch(() => null)
            getSocketIo()?.to(`user:${userId}`).emit('cex-sm:trade', { side: 'SELL', pair: open.pair, skim: true })
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            await appendTradingLog(userId, 'SYSTEM', `[cex-sm] profit skim SELL failed: ${msg}`)
            logger.warn({ err, userId, symbol: open.symbol }, '[cex-sm] auto skim failed')
          }
          return
        }

        if (reason) {
          // Never try to sell more than the account actually holds.
          const sellQty = Math.min(open.baseQty, freeBase)
          try {
            await placeOrder({
              userId,
              exchangeConnectionId: connId,
              symbol: open.symbol,
              side: OrderSide.SELL,
              type: OrderType.MARKET,
              quantity: sellQty,
              price: mark,
            })
            await prisma.cexSuperMachineConfig.update({ where: { userId }, data: CLEAR_OPEN_LOT })
            clearCexPositionTracking(userId)
            await appendTradingLog(
              userId,
              'EXEC',
              `[cex-sm] ${reason} ${pnlPct.toFixed(2)}% — sold ${open.pair}`,
              { source: 'binance-cex-super-machine', reason, pnlPct, mark },
            )
            void telegramService
              .notifyDexBotTrade({
                userId,
                action: 'SELL',
                pair: open.pair,
                reason:
                  reason === 'take_profit'
                    ? 'Binance take-profit'
                    : reason === 'trailing_stop'
                      ? 'Binance trailing stop'
                      : 'Binance stop-loss',
                fillPriceUsd: mark,
                entryPriceUsd: open.entryPrice,
                // Banked skim profit rides along so the close alert shows the full win.
                realizedPnlUsd: (mark - open.entryPrice) * sellQty + open.skimmedUsd,
                trigger: 'auto',
                walletLabel: 'Binance',
              })
              .catch(() => null)
            getSocketIo()?.to(`user:${userId}`).emit('cex-sm:exit', { reason, pnlPct, pair: open.pair })
          } catch (err) {
            // The lot stays on the row so the next tick retries the exit.
            const msg = err instanceof Error ? err.message : String(err)
            await appendTradingLog(userId, 'SYSTEM', `[cex-sm] ${reason} SELL failed: ${msg}`)
            logger.warn({ err, userId, symbol: open.symbol, reason }, '[cex-sm] exit failed')
            void telegramService
              .notifyTradeFailed({
                userId,
                symbol: open.symbol,
                side: 'SELL',
                errorType: `cex_auto_${reason}`,
                message: msg.slice(0, 1500),
              })
              .catch(() => null)
          }
          return
        }
      }
    }
  }

  const decision = await cexCouncilEvaluate({
    userId,
    settings: {
      maxTradeUsd: settings.maxTradeUsd,
      watchSymbol: symbol,
      hasOpenLong: open != null,
    },
    freeUsdt: freeQuoteUsd,
  })

  getSocketIo()?.to(`user:${userId}`).emit('cex-sm:tick', {
    decision,
    freeUsdt: freeQuoteUsd,
    openPosition: open,
  })

  if (decision.action !== 'BUY' || decision.orderSizeUsd < 5) return
  if (open) return
  const lastBuy = row.lastBuyAt?.getTime() ?? 0
  if (Date.now() - lastBuy < BUY_COOLDOWN_MS) return

  const book = await fetchBookTicker(symbol)
  const px = book?.ask ?? book?.mid
  if (px == null || px <= 0) return

  try {
    const filled = await placeOrder({
      userId,
      exchangeConnectionId: connId,
      symbol,
      side: OrderSide.BUY,
      type: OrderType.MARKET,
      quantity: decision.orderSizeUsd,
      quoteOrderQty: decision.orderSizeUsd,
      price: px,
    })
    const qty = Number(filled.filledQuantity ?? 0)
    if (qty <= 0) {
      await appendTradingLog(userId, 'SYSTEM', '[cex-sm] BUY returned zero fill')
      return
    }
    const spent = Number(filled.quoteQuantity ?? 0) || decision.orderSizeUsd
    const entry = Number(filled.avgFillPrice ?? 0) > 0 ? Number(filled.avgFillPrice) : spent / qty

    await prisma.cexSuperMachineConfig.update({
      where: { userId },
      data: {
        openSymbol: symbol,
        openPair: pair,
        openEntryPrice: entry,
        openBaseQty: qty,
        openQuoteSpent: spent,
        openedAt: new Date(),
        lastBuyAt: new Date(),
      },
    })

    await appendTradingLog(
      userId,
      'EXEC',
      `[cex-sm] Council BUY ${pair} $${spent.toFixed(2)} · consensus ${(decision.consensus * 100).toFixed(0)}%`,
      {
        source: 'binance-cex-super-machine',
        decisionId: decision.id,
        reasons: decision.reasons,
        votes: decision.votes,
      },
    )
    void telegramService
      .notifyDexBotTrade({
        userId,
        action: 'BUY',
        pair,
        reason: `Binance council BUY · consensus ${(decision.consensus * 100).toFixed(0)}%`,
        fillPriceUsd: entry,
        usdtSpent: spent,
        trigger: 'auto',
        walletLabel: 'Binance',
      })
      .catch(() => null)
    getSocketIo()?.to(`user:${userId}`).emit('cex-sm:trade', {
      side: 'BUY',
      pair,
      orderSizeUsd: spent,
      consensus: decision.consensus,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await appendTradingLog(userId, 'SYSTEM', `[cex-sm] BUY failed: ${msg}`)
    logger.warn({ err, userId, symbol }, '[cex-sm] buy failed')
    void telegramService
      .notifyTradeFailed({
        userId,
        symbol,
        side: 'BUY',
        errorType: 'cex_auto_buy',
        message: msg.slice(0, 1500),
      })
      .catch(() => null)
  }
}

async function tickAll(): Promise<void> {
  // Read from the DB, not memory: after a restart nobody is in a local Map, so
  // an enabled machine (and any open lot) would otherwise never be ticked again.
  const rows = await prisma.cexSuperMachineConfig.findMany({
    where: { enabled: true, emergencyStop: false },
  })
  for (const row of rows) {
    try {
      await tickUser(row)
    } catch (err) {
      logger.warn({ err, userId: row.userId }, '[cex-sm] tick error')
    }
  }
}

export function startCexSuperMachineWatcher(): void {
  if (watcher) return
  watcher = setInterval(() => {
    void tickAll()
  }, TICK_MS)
  void tickAll()
  logger.info('[cex-sm] Binance CEX Super Machine watcher started')
}

export function stopCexSuperMachineWatcher(): void {
  if (watcher) clearInterval(watcher)
  watcher = null
}

/** Startup log so an operator can see whether any machine survived the restart. */
export async function loadCexSuperMachineFromDb(): Promise<void> {
  const [enabled, withOpenLot] = await Promise.all([
    prisma.cexSuperMachineConfig.count({ where: { enabled: true, emergencyStop: false } }),
    prisma.cexSuperMachineConfig.count({ where: { enabled: true, openSymbol: { not: null } } }),
  ])
  if (enabled > 0) {
    logger.info({ enabled, withOpenLot }, '[cex-sm] restored enabled machines from DB')
  }
}
