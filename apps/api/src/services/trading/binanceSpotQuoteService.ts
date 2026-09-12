/**
 * Binance Spot quotes for the smart execution router (per-user API keys).
 */
import { prisma } from '@cryptoflow/db'
import { decryptSecret } from '../../lib/crypto'
import { binanceAdapter } from '../exchange/binanceAdapter'
import { env } from '../../lib/env'

const BINANCE_PUBLIC = (process.env.BINANCE_BASE_URL ?? 'https://api.binance.com').replace(/\/$/, '')

export const CEX_BINANCE_STRATEGY_NAME = 'CEX Binance Spot'

export type BinanceVenueQuote = {
  venue: 'binance'
  available: boolean
  reason?: string
  binanceSymbol: string
  side: 'BUY' | 'SELL'
  /** USDT per 1 base token (all-in estimate incl. taker fee). */
  executablePrice: number | null
  amountInHuman: number
  amountOutHuman: number
  binanceMid: number | null
  bid: number | null
  ask: number | null
  feeBps: number
  usdtFree: number | null
  baseFree: number | null
  baseAsset: string
}

export async function getUserBinanceConnection(userId: string) {
  return prisma.exchangeConnection.findFirst({
    where: { userId, exchange: 'BINANCE', isActive: true, canTrade: true },
  })
}

export async function fetchBookTicker(binanceSymbol: string): Promise<{
  bid: number
  ask: number
  mid: number
} | null> {
  try {
    const r = await fetch(
      `${BINANCE_PUBLIC}/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(binanceSymbol)}`,
      { signal: AbortSignal.timeout(6000) },
    )
    if (!r.ok) return null
    const row = (await r.json()) as { bidPrice?: string; askPrice?: string }
    const bid = parseFloat(row.bidPrice ?? 'NaN')
    const ask = parseFloat(row.askPrice ?? 'NaN')
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null
    return { bid, ask, mid: (bid + ask) / 2 }
  } catch {
    return null
  }
}

function baseAssetFromSymbol(binanceSymbol: string): string {
  return binanceSymbol.replace(/USDT$/i, '')
}

export async function quoteBinanceSpotForUser(
  userId: string,
  input: { binanceSymbol: string; side: 'BUY' | 'SELL'; amount: number },
): Promise<BinanceVenueQuote> {
  const binanceSymbol = input.binanceSymbol.toUpperCase()
  const baseAsset = baseAssetFromSymbol(binanceSymbol)
  const feeBps = env.smartRouterBinanceTakerFeeBps
  const feeMul = feeBps / 10_000

  const book = await fetchBookTicker(binanceSymbol)
  const empty: BinanceVenueQuote = {
    venue: 'binance',
    available: false,
    reason: 'Binance book unavailable',
    binanceSymbol,
    side: input.side,
    executablePrice: null,
    amountInHuman: input.amount,
    amountOutHuman: 0,
    binanceMid: book?.mid ?? null,
    bid: book?.bid ?? null,
    ask: book?.ask ?? null,
    feeBps,
    usdtFree: null,
    baseFree: null,
    baseAsset,
  }
  if (!book) return empty

  const conn = await getUserBinanceConnection(userId)
  if (!conn) {
    return {
      ...empty,
      reason: 'Connect Binance API keys on the Exchange page (trade-only key, no withdraw).',
    }
  }

  let usdtFree: number | null = null
  let baseFree: number | null = null
  try {
    const apiKey = decryptSecret(conn.encryptedApiKey)
    const apiSecret = decryptSecret(conn.encryptedSecret)
    const balances = await binanceAdapter.getBalances(apiKey, apiSecret)
    for (const b of balances) {
      if (b.asset === 'USDT') usdtFree = parseFloat(b.free)
      if (b.asset === baseAsset) baseFree = parseFloat(b.free)
    }
  } catch (e) {
    return {
      ...empty,
      reason: e instanceof Error ? e.message : 'Binance balance check failed',
    }
  }

  if (input.side === 'BUY') {
    const usdtNeed = input.amount
    if (usdtFree != null && usdtFree < usdtNeed * 0.999) {
      return {
        ...empty,
        usdtFree,
        baseFree,
        reason: `Insufficient USDT on Binance (need ${usdtNeed.toFixed(2)}, have ${usdtFree.toFixed(2)}).`,
      }
    }
    const executablePrice = book.ask * (1 + feeMul)
    const amountOutHuman = usdtNeed / executablePrice
    return {
      venue: 'binance',
      available: true,
      binanceSymbol,
      side: 'BUY',
      executablePrice,
      amountInHuman: usdtNeed,
      amountOutHuman,
      binanceMid: book.mid,
      bid: book.bid,
      ask: book.ask,
      feeBps,
      usdtFree,
      baseFree,
      baseAsset,
    }
  }

  const baseQty = input.amount
  if (baseFree != null && baseFree < baseQty * 0.999) {
    return {
      ...empty,
      usdtFree,
      baseFree,
      reason: `Insufficient ${baseAsset} on Binance (need ${baseQty}, have ${baseFree?.toFixed(6) ?? '0'}).`,
    }
  }
  const executablePrice = book.bid * (1 - feeMul)
  const amountOutHuman = baseQty * executablePrice
  return {
    venue: 'binance',
    available: true,
    binanceSymbol,
    side: 'SELL',
    executablePrice,
    amountInHuman: baseQty,
    amountOutHuman,
    binanceMid: book.mid,
    bid: book.bid,
    ask: book.ask,
    feeBps,
    usdtFree,
    baseFree,
    baseAsset,
  }
}
