/**
 * Manual trading desk for Binance spot.
 *
 * The Super Machine trades on its own; this is the path for a user who wants to
 * pull the trigger themselves but still see what the council sees. Every manual
 * order goes through the same OMS as the automated one, so risk limits, lot
 * sizing and minimum notional are enforced identically.
 */
import { appendTradingLog } from '@cryptoflow/bot'
import { OrderSide, OrderType, prisma } from '@cryptoflow/db'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { decryptSecret } from '../../lib/crypto'
import { getSocketIo } from '../../lib/realtimeHub'
import { binanceSpotAdapter } from '../exchange/binanceSpotAdapter'
import { tryGetBinanceSymbolRules } from '../exchange/binanceSymbolRulesService'
import { getCexExitSettings } from '../exchange/cexExitSettingsService'
import { placeOrder } from '../orders/orderService'
import { computeAutomationReadiness } from '../risk/readiness'
import { type MarketContext } from '../market/marketContextService'
import { orderBookService } from '../market/orderBook'
import { computeEnhancedSignalSnapshot } from '../signals/providersHub'
import { technicalVote } from '../agents/technicalAgent'
import { telegramService } from '../notifications/telegramService'
import { fetchBookTicker } from './binanceSpotQuoteService'
import {
  freeAsset,
  sumQuoteStables,
} from '../exchange/binanceBalanceHelpers'
import { baseFromCexSymbol, resolveCexTradeSymbol } from './cexSymbolResolver'

export type ManualSide = 'BUY' | 'SELL'

export type ManualDesk = {
  symbol: string
  /** Binance pair actually used (USDT or USDC quote). */
  tradeSymbol: string
  quoteAsset: 'USDT' | 'USDC'
  pair: string
  baseAsset: string
  connectionId: string | null
  readiness: { ready: boolean; blockers: string[] }
  balances: { freeUsdt: number; freeUsdc: number; freeQuoteUsd: number; freeBase: number; error?: string | null }
  book: { bid: number | null; ask: number | null; mid: number | null; spreadBps: number | null } | null
  rules: { minQty: number; stepSize: number; minNotional: number } | null
  limits: { maxOrderUsd: number }
  signal: {
    consensus: string
    confidence: number
    technical: { vote: string; confidence: number; reason: string; rsi14: number | null }
    orderBookImbalance: number | null
    change24hPct: number | null
    context: MarketContext | null
  }
  suggestion: {
    action: ManualSide | 'WAIT'
    sizeUsd: number
    conviction: number
    reasons: string[]
    cautions: string[]
    entryHint: number | null
    takeProfitHint: number | null
    stopLossHint: number | null
  }
  openPosition: { symbol: string; baseQty: number; entryPrice: number; pnlPct: number | null } | null
  updatedAt: string
}

export type ManualPreflight = {
  ok: boolean
  blockers: string[]
  warnings: string[]
  order: {
    symbol: string
    side: ManualSide
    quoteOrderQty: number | null
    quantity: number | null
    estPrice: number | null
    estBaseQty: number | null
    estQuoteValue: number | null
    minNotional: number | null
    stepSize: number | null
  }
  /** Whether the order runs with or against the current council read. */
  signalAlignment: 'with' | 'against' | 'neutral'
}

export type ManualTradeRequest = {
  symbol: string
  side: ManualSide
  /** BUY: USDT to spend. Ignored for SELL. */
  quoteOrderQty?: number
  /** SELL: base units to sell. Ignored for BUY. */
  quantity?: number
  /** SELL shortcut: fraction of the free base balance (0-1). */
  fraction?: number
  /** Hand the resulting lot to the Auto Binance exit engine for TP/SL. */
  attachExits?: boolean
}

const MIN_ORDER_USD = 5

function normalizeSymbol(symbol: string): string {
  return symbol.replace('/', '').toUpperCase()
}

async function resolveConnectionId(userId: string): Promise<string | null> {
  const conn = await prisma.exchangeConnection.findFirst({
    where: { userId, isActive: true, canTrade: true, canWithdraw: false, exchange: 'BINANCE' },
    orderBy: { updatedAt: 'desc' },
  })
  return conn?.id ?? null
}

async function loadBalances(
  userId: string,
  connectionId: string | null,
  baseAsset: string,
): Promise<{
  freeUsdt: number
  freeUsdc: number
  freeQuoteUsd: number
  freeBase: number
  error: string | null
}> {
  if (!connectionId) {
    return { freeUsdt: 0, freeUsdc: 0, freeQuoteUsd: 0, freeBase: 0, error: null }
  }
  const conn = await prisma.exchangeConnection.findFirst({ where: { id: connectionId, userId } })
  if (!conn) {
    return { freeUsdt: 0, freeUsdc: 0, freeQuoteUsd: 0, freeBase: 0, error: null }
  }

  try {
    const balances = await binanceSpotAdapter.getBalances(
      decryptSecret(conn.encryptedApiKey),
      decryptSecret(conn.encryptedSecret),
    )
    const freeUsdt = freeAsset(balances, 'USDT')
    const freeUsdc = freeAsset(balances, 'USDC')
    return {
      freeUsdt,
      freeUsdc,
      freeQuoteUsd: sumQuoteStables(balances),
      freeBase: freeAsset(balances, baseAsset),
      error: null,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Balance read failed'
    logger.warn({ err, userId }, '[cex-manual] balance read failed')
    return { freeUsdt: 0, freeUsdc: 0, freeQuoteUsd: 0, freeBase: 0, error: msg }
  }
}

/** The desk view: balances, live book, the council's read, and a sized suggestion. */
export async function getManualDesk(userId: string, rawSymbol: string): Promise<ManualDesk> {
  const connectionId = await resolveConnectionId(userId)
  const baseAsset = baseFromCexSymbol(normalizeSymbol(rawSymbol))
  const balances = await loadBalances(userId, connectionId, baseAsset)
  const resolved = resolveCexTradeSymbol(rawSymbol, balances, 'BUY')
  const symbol = resolved.symbol
  const pair = resolved.pair

  const [readiness, rawBook, rules, snapshot, tech, exits, smRow] = await Promise.all([
    computeAutomationReadiness(userId, connectionId ?? undefined),
    fetchBookTicker(symbol).catch(() => null),
    tryGetBinanceSymbolRules(symbol),
    computeEnhancedSignalSnapshot(symbol).catch(() => null),
    technicalVote(symbol),
    getCexExitSettings(userId),
    prisma.cexSuperMachineConfig.findUnique({ where: { userId } }),
  ])

  let book = rawBook
  if (!book) {
    const depth = await orderBookService.getDepth(symbol).catch(() => null)
    if (depth && depth.bids[0] && depth.asks[0]) {
      book = {
        bid: depth.bids[0].price,
        ask: depth.asks[0].price,
        mid: depth.mid ?? (depth.bids[0].price + depth.asks[0].price) / 2,
      }
    }
  }

  const mid = book?.mid ?? snapshot?.market.lastPrice ?? null
  const spreadBps =
    book?.bid != null && book?.ask != null && book.mid > 0 ? ((book.ask - book.bid) / book.mid) * 10_000 : null

  const consensus = snapshot?.consensus.signal ?? 'HOLD'
  const confidence = snapshot?.consensus.confidence ?? 0
  const obi = orderBookService.getOBI(symbol)
  const context = tech.context

  const reasons: string[] = []
  const cautions: string[] = []

  if (context?.available) reasons.push(context.headline)
  if (snapshot?.recommendation.rationale[0]) reasons.push(snapshot.recommendation.rationale[0])
  reasons.push(`Technical: ${tech.reason}`)
  if (obi != null) reasons.push(`Order book imbalance ${obi.toFixed(2)}`)

  if (spreadBps != null && spreadBps > 15) cautions.push(`Spread ${spreadBps.toFixed(1)} bps is wide — expect slippage`)
  if (snapshot?.recommendation.riskNotes[0]) cautions.push(snapshot.recommendation.riskNotes[0])
  if (context?.regime === 'high_volatility') cautions.push('High volatility regime — size down')
  if (context?.regime === 'choppy') cautions.push('Choppy regime — trend signals are unreliable here')
  if (context?.longHorizon?.trend === 'bear') cautions.push('Price is in a 1-year downtrend')
  if (balances.freeQuoteUsd < MIN_ORDER_USD) {
    cautions.push(
      `Spendable stablecoins $${balances.freeQuoteUsd.toFixed(2)} (USDT+USDC) below $${MIN_ORDER_USD} minimum`,
    )
  }

  const open =
    smRow?.openSymbol && smRow.openBaseQty != null && smRow.openEntryPrice != null
      ? {
          symbol: smRow.openSymbol,
          baseQty: Number(smRow.openBaseQty),
          entryPrice: Number(smRow.openEntryPrice),
          pnlPct:
            mid != null && Number(smRow.openEntryPrice) > 0
              ? ((mid - Number(smRow.openEntryPrice)) / Number(smRow.openEntryPrice)) * 100
              : null,
        }
      : null

  // Conviction blends the provider consensus with how many stored timeframes agree.
  const alignment = context?.alignment.score ?? 0
  const conviction = Math.min(
    0.95,
    Math.max(0, confidence * 0.6 + (alignment + 1) / 2 * 0.25 + (tech.vote === 'BUY' ? 0.15 : 0)),
  )

  let action: ManualDesk['suggestion']['action'] = 'WAIT'
  if (consensus === 'BUY' && tech.vote !== 'AVOID' && conviction >= 0.5 && balances.freeQuoteUsd >= MIN_ORDER_USD) {
    action = 'BUY'
  } else if (open != null && (consensus === 'SELL' || tech.vote === 'AVOID')) {
    action = 'SELL'
  }

  const maxOrderUsd = env.CEX_LIVE_MAX_ORDER_USDT
  const suggestedSize = Math.min(
    maxOrderUsd,
    Math.max(0, Math.floor(Math.min(balances.freeQuoteUsd * 0.95, maxOrderUsd) * conviction * 100) / 100),
  )

  return {
    symbol,
    tradeSymbol: symbol,
    quoteAsset: resolved.quoteAsset,
    pair,
    baseAsset,
    connectionId,
    readiness: { ready: readiness.ready, blockers: readiness.blockers },
    balances,
    book: book ? { bid: book.bid, ask: book.ask, mid: book.mid, spreadBps } : null,
    rules: rules
      ? {
          minQty: Number(rules.lot.minQty),
          stepSize: Number(rules.lot.stepSize),
          minNotional: rules.minNotional,
        }
      : null,
    limits: { maxOrderUsd },
    signal: {
      consensus,
      confidence,
      technical: { vote: tech.vote, confidence: tech.confidence, reason: tech.reason, rsi14: tech.rsi14 },
      orderBookImbalance: obi,
      change24hPct: snapshot?.market.change24hPct ?? null,
      context,
    },
    suggestion: {
      action,
      sizeUsd: action === 'BUY' ? Math.max(0, suggestedSize) : 0,
      conviction,
      reasons: reasons.filter(Boolean),
      cautions,
      entryHint: mid,
      takeProfitHint: mid != null ? mid * (1 + exits.takeProfitPct / 100) : null,
      stopLossHint: mid != null ? mid * (1 - exits.stopLossPct / 100) : null,
    },
    openPosition: open,
    updatedAt: new Date().toISOString(),
  }
}

/** Dry run: everything that would reject the order, plus what it would fill at. */
export async function previewManualTrade(
  userId: string,
  request: ManualTradeRequest,
): Promise<ManualPreflight> {
  const side = request.side
  const connectionId = await resolveConnectionId(userId)
  const baseAsset = baseFromCexSymbol(normalizeSymbol(request.symbol))
  const balances = await loadBalances(userId, connectionId, baseAsset)
  const spend = side === 'BUY' ? Number(request.quoteOrderQty ?? 0) : undefined
  const resolved = resolveCexTradeSymbol(request.symbol, balances, side, spend)
  const symbol = resolved.symbol

  const [readiness, book, rules, tech] = await Promise.all([
    computeAutomationReadiness(userId, connectionId ?? undefined),
    fetchBookTicker(symbol).catch(() => null),
    tryGetBinanceSymbolRules(symbol),
    technicalVote(symbol),
  ])

  const blockers: string[] = []
  const warnings: string[] = []

  if (!connectionId) blockers.push('No trade-only Binance connection. Add API keys with trading enabled and withdrawals disabled.')
  if (!env.LIVE_AUTOMATION_ENABLED) blockers.push('Live trading is disabled on this deployment.')
  for (const b of readiness.blockers) blockers.push(b)

  const estPrice = side === 'BUY' ? (book?.ask ?? book?.mid ?? null) : (book?.bid ?? book?.mid ?? null)
  if (estPrice == null || estPrice <= 0) blockers.push(`No live price for ${symbol}.`)

  let quoteOrderQty: number | null = null
  let quantity: number | null = null
  let estBaseQty: number | null = null
  let estQuoteValue: number | null = null

  if (side === 'BUY') {
    quoteOrderQty = Number(request.quoteOrderQty ?? 0)
    if (!Number.isFinite(quoteOrderQty) || quoteOrderQty <= 0) {
      blockers.push(`Enter how much ${resolved.quoteAsset} to spend.`)
    } else {
      if (quoteOrderQty < MIN_ORDER_USD) blockers.push(`Minimum order is $${MIN_ORDER_USD}.`)
      if (quoteOrderQty > env.CEX_LIVE_MAX_ORDER_USDT) {
        blockers.push(`Order exceeds the $${env.CEX_LIVE_MAX_ORDER_USDT} per-order cap.`)
      }
      const quoteFree = resolved.quoteAsset === 'USDC' ? balances.freeUsdc : balances.freeUsdt
      if (quoteOrderQty > quoteFree) {
        blockers.push(
          `Not enough ${resolved.quoteAsset}: have $${quoteFree.toFixed(2)}, need $${quoteOrderQty.toFixed(2)} for ${resolved.pair}.`,
        )
      }
      if (rules && rules.minNotional > 0 && quoteOrderQty < rules.minNotional) {
        blockers.push(`Binance requires at least $${rules.minNotional} notional on ${symbol}.`)
      }
      estQuoteValue = quoteOrderQty
      estBaseQty = estPrice != null && estPrice > 0 ? quoteOrderQty / estPrice : null
    }
  } else {
    const fraction = request.fraction
    const requested =
      fraction != null && fraction > 0
        ? balances.freeBase * Math.min(1, fraction)
        : Number(request.quantity ?? 0)

    quantity = Number.isFinite(requested) ? requested : 0
    if (quantity <= 0) blockers.push(`Enter how much ${baseAsset} to sell.`)
    else if (quantity > balances.freeBase) {
      blockers.push(`Free ${baseAsset} balance is ${balances.freeBase} — cannot sell ${quantity}.`)
    }

    if (rules) {
      const step = Number(rules.lot.stepSize)
      if (step > 0) quantity = Math.floor(quantity / step) * step
      if (quantity < Number(rules.lot.minQty)) {
        blockers.push(`Below the Binance minimum quantity of ${rules.lot.minQty} ${baseAsset}.`)
      }
    }

    estBaseQty = quantity
    estQuoteValue = estPrice != null ? quantity * estPrice : null
    if (rules && rules.minNotional > 0 && estQuoteValue != null && estQuoteValue < rules.minNotional) {
      blockers.push(`Sale value $${estQuoteValue.toFixed(2)} is below the $${rules.minNotional} Binance minimum.`)
    }
  }

  const spreadBps =
    book?.bid != null && book?.ask != null && book.mid > 0 ? ((book.ask - book.bid) / book.mid) * 10_000 : null
  if (spreadBps != null && spreadBps > 15) {
    warnings.push(`Spread is ${spreadBps.toFixed(1)} bps — a market order will pay that.`)
  }

  const ctx = tech.context
  let signalAlignment: ManualPreflight['signalAlignment'] = 'neutral'
  if (side === 'BUY') {
    if (tech.vote === 'AVOID') {
      signalAlignment = 'against'
      warnings.push(`Technical agent says AVOID: ${tech.reason}`)
    } else if (tech.vote === 'BUY') {
      signalAlignment = 'with'
    }
    if (ctx?.available && ctx.alignment.score <= -0.5) {
      signalAlignment = 'against'
      warnings.push(`${ctx.alignment.bearish}/${ctx.alignment.total} higher timeframes are bearish.`)
    }
    if (ctx?.longHorizon && ctx.longHorizon.pctFromHigh52w > -2) {
      warnings.push('Buying at 52-week highs — confirm this is a breakout, not exhaustion.')
    }
  } else if (side === 'SELL' && tech.vote === 'BUY') {
    signalAlignment = 'against'
    warnings.push(`Technical agent still reads BUY: ${tech.reason}`)
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    order: {
      symbol,
      side,
      quoteOrderQty,
      quantity,
      estPrice,
      estBaseQty,
      estQuoteValue,
      minNotional: rules?.minNotional ?? null,
      stepSize: rules ? Number(rules.lot.stepSize) : null,
    },
    signalAlignment,
  }
}

export type ManualTradeResult = {
  ok: true
  orderId: string
  side: ManualSide
  symbol: string
  pair: string
  filledQty: number
  quoteValue: number
  avgPrice: number | null
  exitsAttached: boolean
  note: string | null
}

/** Places the order through the OMS after re-running preflight server-side. */
export async function executeManualTrade(
  userId: string,
  request: ManualTradeRequest,
): Promise<ManualTradeResult> {
  const preflight = await previewManualTrade(userId, request)
  if (!preflight.ok) {
    throw new Error(preflight.blockers[0] ?? 'Manual trade preflight failed')
  }

  const connectionId = await resolveConnectionId(userId)
  if (!connectionId) throw new Error('No trade-only Binance connection')

  const { symbol, side, estPrice } = preflight.order
  const baseAsset = baseFromCexSymbol(symbol)
  const pair = symbol.endsWith('USDC') ? `${baseAsset}/USDC` : `${baseAsset}/USDT`

  const filled = await placeOrder({
    userId,
    exchangeConnectionId: connectionId,
    symbol,
    side: side === 'BUY' ? OrderSide.BUY : OrderSide.SELL,
    type: OrderType.MARKET,
    quantity: side === 'BUY' ? (preflight.order.quoteOrderQty ?? 0) : (preflight.order.quantity ?? 0),
    quoteOrderQty: side === 'BUY' ? (preflight.order.quoteOrderQty ?? undefined) : undefined,
    price: estPrice ?? undefined,
  })

  const filledQty = Number(filled.filledQuantity ?? 0)
  const quoteValue = Number(filled.quoteQuantity ?? 0) || (preflight.order.estQuoteValue ?? 0)
  const avgPrice =
    Number(filled.avgFillPrice ?? 0) > 0
      ? Number(filled.avgFillPrice)
      : filledQty > 0
        ? quoteValue / filledQty
        : estPrice

  let exitsAttached = false
  let note: string | null = null

  if (side === 'BUY' && filledQty > 0 && avgPrice != null && avgPrice > 0) {
    const existing = await prisma.cexSuperMachineConfig.findUnique({ where: { userId } })
    const prevSymbol = existing?.openSymbol
    const prevQty = Number(existing?.openBaseQty ?? 0)

    if (prevSymbol && prevSymbol !== symbol && prevQty > 0) {
      note = `Open lot stays on ${prevSymbol} — sell or flatten it before tracking ${symbol}.`
    } else if (prevSymbol === symbol && prevQty > 0) {
      const prevCost = Number(existing?.openQuoteSpent ?? 0)
      const newQty = prevQty + filledQty
      const newCost = prevCost + quoteValue
      await prisma.cexSuperMachineConfig.update({
        where: { userId },
        data: {
          openSymbol: symbol,
          openPair: pair,
          openBaseQty: newQty,
          openQuoteSpent: newCost,
          openEntryPrice: newCost / newQty,
          openedAt: existing?.openedAt ?? new Date(),
        },
      })
    } else {
      await prisma.cexSuperMachineConfig.upsert({
        where: { userId },
        create: {
          userId,
          watchSymbol: symbol,
          openSymbol: symbol,
          openPair: pair,
          openEntryPrice: avgPrice,
          openBaseQty: filledQty,
          openQuoteSpent: quoteValue,
          openedAt: new Date(),
        },
        update: {
          openSymbol: symbol,
          openPair: pair,
          openEntryPrice: avgPrice,
          openBaseQty: filledQty,
          openQuoteSpent: quoteValue,
          openedAt: new Date(),
        },
      })
    }

    if (request.attachExits) {
      exitsAttached = true
      if (!existing?.enabled) {
        note =
          note ??
          'Exits are attached but Auto Binance is switched off — turn it on for take-profit and stop-loss to run.'
      }
    }
  }

  if (side === 'SELL' && filledQty > 0) {
    // A manual sell can flatten or shrink the lot the exit engine is watching.
    const existing = await prisma.cexSuperMachineConfig.findUnique({ where: { userId } })
    const bookedQty = Number(existing?.openBaseQty ?? 0)
    if (existing?.openSymbol === symbol && bookedQty > 0) {
      const remaining = bookedQty - filledQty
      if (remaining <= bookedQty * 0.05) {
        await prisma.cexSuperMachineConfig.update({
          where: { userId },
          data: {
            openSymbol: null,
            openPair: null,
            openEntryPrice: null,
            openBaseQty: null,
            openQuoteSpent: null,
            openedAt: null,
          },
        })
        note = 'Closed the tracked Auto Binance position.'
      } else {
        const spent = Number(existing.openQuoteSpent ?? 0)
        await prisma.cexSuperMachineConfig.update({
          where: { userId },
          data: {
            openBaseQty: remaining,
            openQuoteSpent: spent * (remaining / bookedQty),
          },
        })
        note = `Reduced the tracked Auto Binance position to ${remaining} ${baseAsset}.`
      }
    }
  }

  await appendTradingLog(
    userId,
    'EXEC',
    `[cex-manual] ${side} ${pair} ${filledQty} @ ${avgPrice?.toFixed(6) ?? '—'} ($${quoteValue.toFixed(2)})`,
    { source: 'binance-cex-manual', orderId: filled.id, exitsAttached },
  )

  void telegramService
    .notifyDexBotTrade({
      userId,
      action: side,
      pair,
      reason: 'Manual Binance order',
      fillPriceUsd: avgPrice ?? 0,
      usdtSpent: side === 'BUY' ? quoteValue : undefined,
      trigger: 'manual',
      walletLabel: 'Binance manual',
    })
    .catch(() => null)

  getSocketIo()?.to(`user:${userId}`).emit('cex-manual:trade', {
    side,
    pair,
    filledQty,
    quoteValue,
    avgPrice,
  })
  getSocketIo()?.to(`user:${userId}`).emit('portfolio:update', { source: 'cex-manual' })

  return {
    ok: true,
    orderId: filled.id,
    side,
    symbol,
    pair,
    filledQty,
    quoteValue,
    avgPrice,
    exitsAttached,
    note,
  }
}
