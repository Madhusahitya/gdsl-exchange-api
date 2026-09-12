/**
 * Execute Binance Spot MARKET orders for the smart router (separate trade book).
 */
import { adjustQuantityToLotSize, parseSymbolRules } from '@cryptoflow/binance-executor'
import { OrderSide, OrderType, prisma, TradeStatus } from '@cryptoflow/db'
import { decryptSecret } from '../../lib/crypto'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { binanceAdapter } from '../exchange/binanceAdapter'
import { roundTripRealizedPnl } from '../../lib/roundTripPnl'
import {
  fetchBookTicker,
  getUserBinanceConnection,
  quoteBinanceSpotForUser,
  CEX_BINANCE_STRATEGY_NAME,
} from './binanceSpotQuoteService'

const BINANCE_PUBLIC = (process.env.BINANCE_BASE_URL ?? 'https://api.binance.com').replace(/\/$/, '')

async function ensureCexStrategyId(): Promise<string> {
  const s = await prisma.strategy.upsert({
    where: { name: CEX_BINANCE_STRATEGY_NAME },
    update: {},
    create: {
      name: CEX_BINANCE_STRATEGY_NAME,
      description: 'Binance Spot fills via smart execution router.',
      riskLevel: 'MEDIUM',
    },
    select: { id: true },
  })
  return s.id
}

const rulesCache = new Map<string, { rules: ReturnType<typeof parseSymbolRules>; at: number }>()
const RULES_TTL_MS = 60 * 60 * 1000

async function getParsedSymbolRules(binanceSymbol: string) {
  const cached = rulesCache.get(binanceSymbol)
  if (cached && Date.now() - cached.at < RULES_TTL_MS) return cached.rules
  const r = await fetch(
    `${BINANCE_PUBLIC}/api/v3/exchangeInfo?symbol=${encodeURIComponent(binanceSymbol)}`,
    { signal: AbortSignal.timeout(8000) },
  )
  if (!r.ok) throw new Error('Binance exchangeInfo failed')
  const data = (await r.json()) as {
    symbols?: Array<Parameters<typeof parseSymbolRules>[0]>
  }
  const sym = data.symbols?.[0]
  if (!sym) throw new Error(`Symbol ${binanceSymbol} not found`)
  const rules = parseSymbolRules(sym)
  rulesCache.set(binanceSymbol, { rules, at: Date.now() })
  return rules
}

export type BinanceSpotTradeResult = {
  venue: 'binance'
  orderId: string
  side: 'BUY' | 'SELL'
  binanceSymbol: string
  trade: {
    id: string
    pair: string
    allocationUsd: number
    entryPrice: number
    exitPrice: number | null
    pnl: number | null
    side: 'BUY' | 'SELL' | 'CLOSED'
    status: 'OPEN' | 'CLOSED'
  }
}

export async function executeBinanceSpotTrade(
  userId: string,
  input: { binanceSymbol: string; side: 'BUY' | 'SELL'; amount: number },
): Promise<BinanceSpotTradeResult> {
  const binanceSymbol = input.binanceSymbol.toUpperCase()
  const baseAsset = binanceSymbol.replace(/USDT$/i, '')
  const pair = `${baseAsset}/USDT`
  const conn = await getUserBinanceConnection(userId)
  if (!conn) throw new Error('Binance API not connected — add keys on the Exchange page.')

  const apiKey = decryptSecret(conn.encryptedApiKey)
  const apiSecret = decryptSecret(conn.encryptedSecret)
  const strategyId = await ensureCexStrategyId()
  const clientOrderId = `gl${Date.now()}${Math.random().toString(36).slice(2, 8)}`.slice(0, 32)

  const remote = await (async () => {
    if (input.side === 'BUY') {
      const usdt = input.amount
      if (usdt < env.smartRouterMinUsdt) {
        throw new Error(`Minimum Binance buy is ${env.smartRouterMinUsdt} USDT.`)
      }
      return binanceAdapter.placeOrder({
        apiKey,
        apiSecret,
        symbol: binanceSymbol,
        side: OrderSide.BUY,
        type: OrderType.MARKET,
        quoteOrderQty: usdt.toFixed(2),
        clientOrderId,
      })
    }
    const rules = await getParsedSymbolRules(binanceSymbol)
    const qtyStr = adjustQuantityToLotSize(input.amount, rules)
    return binanceAdapter.placeOrder({
      apiKey,
      apiSecret,
      symbol: binanceSymbol,
      side: OrderSide.SELL,
      type: OrderType.MARKET,
      quantity: qtyStr,
      clientOrderId,
    })
  })() as {
    orderId: string | number
    executedQty?: string
    cummulativeQuoteQty?: string
    status?: string
  }

  const executedQty = parseFloat(remote.executedQty ?? '0')
  const quoteQty = parseFloat(remote.cummulativeQuoteQty ?? '0')
  let entryPrice = 0
  let allocationUsd = 0
  if (input.side === 'BUY') {
    allocationUsd = quoteQty > 0 ? quoteQty : input.amount
    entryPrice = executedQty > 1e-18 ? allocationUsd / executedQty : 0
  } else {
    allocationUsd = quoteQty
    entryPrice = executedQty > 1e-18 ? quoteQty / executedQty : 0
  }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    const book = await fetchBookTicker(binanceSymbol)
    entryPrice = book?.mid ?? 0
  }

  logger.info(
    { userId, pair, side: input.side, orderId: remote.orderId, entryPrice, allocationUsd },
    '[smartRouter] Binance spot fill',
  )

  if (input.side === 'BUY') {
    const created = await prisma.trade.create({
      data: {
        userId,
        strategyId,
        pair,
        entryPrice,
        exitPrice: null,
        pnl: null,
        allocationUsd: allocationUsd > 0 ? allocationUsd : null,
        status: TradeStatus.OPEN,
      },
    })
    return {
      venue: 'binance',
      orderId: String(remote.orderId),
      side: 'BUY',
      binanceSymbol,
      trade: {
        id: created.id,
        pair,
        side: 'BUY',
        allocationUsd,
        entryPrice,
        exitPrice: null,
        pnl: null,
        status: 'OPEN',
      },
    }
  }

  const openPos = await prisma.trade.findFirst({
    where: { userId, pair, strategyId, status: TradeStatus.OPEN },
    orderBy: { createdAt: 'asc' },
  })
  if (openPos) {
    const buyAlloc = Number(openPos.allocationUsd ?? 0)
    const realized = roundTripRealizedPnl(buyAlloc, Number(openPos.entryPrice), entryPrice)
    const updated = await prisma.trade.update({
      where: { id: openPos.id },
      data: { exitPrice: entryPrice, pnl: realized, status: TradeStatus.CLOSED },
    })
    return {
      venue: 'binance',
      orderId: String(remote.orderId),
      side: 'SELL',
      binanceSymbol,
      trade: {
        id: updated.id,
        pair,
        side: 'CLOSED',
        allocationUsd: buyAlloc,
        entryPrice: Number(updated.entryPrice),
        exitPrice: entryPrice,
        pnl: realized,
        status: 'CLOSED',
      },
    }
  }

  const created = await prisma.trade.create({
    data: {
      userId,
      strategyId,
      pair,
      entryPrice,
      exitPrice: null,
      pnl: null,
      allocationUsd: allocationUsd > 0 ? allocationUsd : null,
      status: TradeStatus.CLOSED,
    },
  })
  return {
    venue: 'binance',
    orderId: String(remote.orderId),
    side: 'SELL',
    binanceSymbol,
    trade: {
      id: created.id,
      pair,
      side: 'SELL',
      allocationUsd,
      entryPrice,
      exitPrice: null,
      pnl: null,
      status: 'CLOSED',
    },
  }
}

/** Dashboard "Sell now" for CEX Binance Spot open book. */
export async function sellBinanceOpenPosition(
  userId: string,
  symbol: string,
): Promise<BinanceSpotTradeResult> {
  const sym = symbol.toUpperCase()
  const pair = `${sym}/USDT`
  const binanceSymbol = `${sym}USDT`
  const strategyId = await ensureCexStrategyId()
  const openTrades = await prisma.trade.findMany({
    where: { userId, pair, strategyId, status: TradeStatus.OPEN },
    orderBy: { createdAt: 'asc' },
  })
  if (openTrades.length === 0) {
    throw new Error(`No open ${sym} position in the Binance Spot trade book`)
  }

  const lotQty = openTrades.reduce((sum, t) => {
    const entry = Number(t.entryPrice)
    const alloc = Number(t.allocationUsd ?? 0)
    return entry > 0 && alloc > 0 ? sum + alloc / entry : sum
  }, 0)
  if (lotQty <= 0) throw new Error(`No ${sym} quantity recorded for open Binance trades`)

  const q = await quoteBinanceSpotForUser(userId, {
    binanceSymbol,
    side: 'SELL',
    amount: lotQty,
  })
  if (!q.available) throw new Error(q.reason ?? `Cannot sell ${sym} on Binance`)
  let sellQty = lotQty
  if (q.baseFree != null && q.baseFree > 0) sellQty = Math.min(lotQty, q.baseFree * 0.999)

  const result = await executeBinanceSpotTrade(userId, {
    binanceSymbol,
    side: 'SELL',
    amount: sellQty,
  })

  for (const t of openTrades.slice(1)) {
    await prisma.trade.update({
      where: { id: t.id },
      data: { status: TradeStatus.CANCELLED },
    })
  }

  return result
}
