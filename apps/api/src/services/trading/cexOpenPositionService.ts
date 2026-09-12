/**
 * Auto Binance open positions for the dashboard equity feed.
 *
 * Primary source: `CexSuperMachineConfig` open lot (Super Machine + manual buys).
 * Fallback: Binance spot balance + most recent filled BUY order when the config
 * row was never seeded (e.g. manual buy without attach-exits on older builds).
 */
import { OrderSide, OrderStatus, prisma } from '@cryptoflow/db'
import { decryptSecret } from '../../lib/crypto'
import { binanceSpotAdapter } from '../exchange/binanceSpotAdapter'
import { freeAsset } from '../exchange/binanceBalanceHelpers'
import { baseFromCexSymbol } from './cexSymbolResolver'
import { fetchBookTicker } from './binanceSpotQuoteService'
import type { OpenPositionSnapshot } from '../portfolio/equityService'

export const AUTO_BINANCE_STRATEGY_NAME = 'Binance'
/** Legacy dashboard book label — kept for dedup when older rows still use it. */
export const AUTO_BINANCE_STRATEGY_NAME_LEGACY = 'Auto Binance'

const MAJOR_BASES = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP'] as const
const DUST_USD = 1

type CexLot = {
  symbol: string
  pair: string
  baseQty: number
  entryPrice: number
  quoteSpent: number
  openedAt: Date
  skimmedUsd: number
}

function pairFromSymbol(symbol: string): string {
  const base = baseFromCexSymbol(symbol)
  if (symbol.endsWith('USDC')) return `${base}/USDC`
  return `${base}/USDT`
}

async function getBookedLot(userId: string): Promise<CexLot | null> {
  const row = await prisma.cexSuperMachineConfig.findUnique({ where: { userId } })
  if (!row?.openSymbol || row.openBaseQty == null || row.openEntryPrice == null) return null
  const baseQty = Number(row.openBaseQty)
  const entryPrice = Number(row.openEntryPrice)
  if (!(baseQty > 0) || !(entryPrice > 0)) return null
  return {
    symbol: row.openSymbol,
    pair: row.openPair ?? pairFromSymbol(row.openSymbol),
    baseQty,
    entryPrice,
    quoteSpent: Number(row.openQuoteSpent ?? baseQty * entryPrice),
    openedAt: row.openedAt ?? row.updatedAt,
    skimmedUsd: Math.max(0, Number(row.openSkimmedUsd ?? 0)),
  }
}

async function inferLotFromWallet(userId: string): Promise<CexLot | null> {
  const conn = await prisma.exchangeConnection.findFirst({
    where: { userId, isActive: true, canTrade: true, canWithdraw: false, exchange: 'BINANCE' },
    orderBy: { updatedAt: 'desc' },
  })
  if (!conn) return null

  let balances
  try {
    balances = await binanceSpotAdapter.getBalances(
      decryptSecret(conn.encryptedApiKey),
      decryptSecret(conn.encryptedSecret),
    )
  } catch {
    return null
  }

  for (const base of MAJOR_BASES) {
    const qty = freeAsset(balances, base)
    if (!(qty > 0)) continue

    const symbols = [`${base}USDT`, `${base}USDC`]
    const lastBuy = await prisma.order.findFirst({
      where: {
        userId,
        exchangeConnectionId: conn.id,
        side: OrderSide.BUY,
        status: OrderStatus.FILLED,
        symbol: { in: symbols },
        filledQuantity: { gt: 0 },
      },
      orderBy: { closedAt: 'desc' },
    })
    if (!lastBuy) continue

    const entryPrice = Number(lastBuy.avgFillPrice ?? 0)
    if (!(entryPrice > 0)) continue

    const book = await fetchBookTicker(lastBuy.symbol).catch(() => null)
    const mark = book?.bid ?? book?.mid ?? entryPrice
    const marketValue = qty * mark
    if (marketValue < DUST_USD) continue

    const quoteSpent = Number(lastBuy.quoteQuantity ?? 0) || qty * entryPrice
    return {
      symbol: lastBuy.symbol,
      pair: pairFromSymbol(lastBuy.symbol),
      baseQty: qty,
      entryPrice,
      quoteSpent,
      openedAt: lastBuy.closedAt ?? lastBuy.createdAt,
      skimmedUsd: 0,
    }
  }

  return null
}

function positionKey(symbol: string, strategyBook: string): string {
  return `${symbol.toUpperCase()}::${strategyBook}`
}

/** Build dashboard open-position rows for Auto Binance (skip symbols already booked elsewhere). */
export async function buildAutoBinanceOpenPositions(
  userId: string,
  existing: OpenPositionSnapshot[],
): Promise<OpenPositionSnapshot[]> {
  const taken = new Set(
    existing.map((p) => positionKey(p.symbol, p.strategyBook ?? '')),
  )

  const lot = (await getBookedLot(userId)) ?? (await inferLotFromWallet(userId))
  if (!lot) return []

  const base = baseFromCexSymbol(lot.symbol)
  if (taken.has(positionKey(base, AUTO_BINANCE_STRATEGY_NAME))) return []
  if (taken.has(positionKey(base, AUTO_BINANCE_STRATEGY_NAME_LEGACY))) return []
  if (taken.has(positionKey(base, 'CEX Binance Spot'))) return []

  const book = await fetchBookTicker(lot.symbol).catch(() => null)
  const mark = book?.bid ?? book?.mid ?? null
  const costBasis = lot.quoteSpent > 0 ? lot.quoteSpent : lot.baseQty * lot.entryPrice
  const marketValue = mark != null ? lot.baseQty * mark : costBasis
  const unrealized = marketValue - costBasis
  const unrealizedPct = costBasis > 0 ? (unrealized / costBasis) * 100 : null

  return [
    {
      symbol: base,
      quantity: lot.baseQty,
      avgEntryPrice: lot.entryPrice,
      markPrice: mark,
      marketValueUsd: marketValue,
      costBasisUsd: costBasis,
      unrealizedPnlUsd: unrealized,
      unrealizedPnlPct: unrealizedPct,
      updatedAt: lot.openedAt.toISOString(),
      markSource: mark != null ? 'binance_spot' : undefined,
      strategyBook: AUTO_BINANCE_STRATEGY_NAME,
      pair: lot.pair,
      skimmedUsd: lot.skimmedUsd > 0 ? lot.skimmedUsd : undefined,
    },
  ]
}
