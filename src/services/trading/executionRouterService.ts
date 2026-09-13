/**
 * Smart execution router — pick Binance Spot vs 1inch BSC for best all-in price.
 */
import { isOneInchConfigured } from '../dex/oneInchClassicService'
import { executeOneInchSwap, previewOneInchSwap } from '../dex/oneInchSwapService'
import { isPersonalWalletEnabled } from '../wallet/personalWalletService'
import { env } from '../../lib/env'
import { quoteBinanceSpotForUser, fetchBookTicker } from './binanceSpotQuoteService'
import { executeBinanceSpotTrade } from './binanceSpotTradeService'

export type ExecutionVenue = 'binance' | 'oneinch_bsc'

export type VenueQuoteSummary = {
  venue: ExecutionVenue
  available: boolean
  reason?: string
  executablePrice: number | null
  amountInHuman: number
  amountOutHuman: number
  /** Estimated extra USD cost vs best venue (0 for winner). */
  extraCostUsd: number
  priceVsBinanceMidBps: number | null
}

export type SmartExecutionQuote = {
  binanceSymbol: string
  side: 'BUY' | 'SELL'
  amount: number
  binanceMid: number | null
  venues: {
    binance: VenueQuoteSummary
    oneinch: VenueQuoteSummary
  }
  recommended: ExecutionVenue | null
  savingsVsOtherBps: number | null
  savingsVsOtherUsd: number
  blockTrade: boolean
  blockReason?: string
}

export type SmartExecutionResult = {
  venue: ExecutionVenue
  binanceSymbol: string
  side: 'BUY' | 'SELL'
  orderId?: string
  txHash?: string
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

function bpsVsMid(executablePrice: number | null, mid: number | null, side: 'BUY' | 'SELL'): number | null {
  if (executablePrice == null || mid == null || mid <= 0) return null
  const raw = ((executablePrice - mid) / mid) * 10_000
  return Math.round(side === 'BUY' ? raw : -raw)
}

function pickWinner(
  side: 'BUY' | 'SELL',
  binance: VenueQuoteSummary,
  oneinch: VenueQuoteSummary,
): { venue: ExecutionVenue | null; savingsBps: number | null; savingsUsd: number } {
  /** BUY: more tokens out wins. SELL: more USDT out wins. */
  const candidates: { venue: ExecutionVenue; out: number; px: number }[] = []
  if (binance.available && binance.executablePrice != null && binance.amountOutHuman > 0) {
    candidates.push({
      venue: 'binance',
      px: binance.executablePrice,
      out: binance.amountOutHuman,
    })
  }
  if (oneinch.available && oneinch.executablePrice != null && oneinch.amountOutHuman > 0) {
    candidates.push({
      venue: 'oneinch_bsc',
      px: oneinch.executablePrice,
      out: oneinch.amountOutHuman,
    })
  }
  if (candidates.length === 0) return { venue: null, savingsBps: null, savingsUsd: 0 }

  const sorted = [...candidates].sort((a, b) => b.out - a.out)
  const best = sorted[0]!
  const second = sorted[1]
  let savingsBps: number | null = null
  let savingsUsd = 0
  if (second) {
    const midPx = (best.px + second.px) / 2
    savingsBps = midPx > 0 ? Math.round((Math.abs(best.px - second.px) / midPx) * 10_000) : null
    if (side === 'BUY') {
      savingsUsd = Math.max(0, (best.out - second.out) * best.px)
    } else {
      savingsUsd = Math.max(0, best.out - second.out)
    }
  }
  return { venue: best.venue, savingsBps, savingsUsd }
}

export async function getSmartExecutionQuote(
  userId: string,
  input: {
    binanceSymbol: string
    side: 'BUY' | 'SELL'
    amount: number
    slippageBps?: number
  },
): Promise<SmartExecutionQuote> {
  const binanceSymbol = input.binanceSymbol.toUpperCase()
  const book = await fetchBookTicker(binanceSymbol)
  const binanceMid = book?.mid ?? null

  const [binanceQ, dexPreview] = await Promise.all([
    quoteBinanceSpotForUser(userId, input),
    (async () => {
      if (!isOneInchConfigured() || !isPersonalWalletEnabled()) {
        return null
      }
      try {
        return await previewOneInchSwap({
          side: input.side,
          binanceSymbol,
          amount: input.amount,
          slippageBps: input.slippageBps,
        })
      } catch (e) {
        return {
          tradable: false,
          message: e instanceof Error ? e.message : 'DEX quote failed',
          executablePrice: null,
          amountInHuman: input.amount,
          amountOutHuman: 0,
          binanceMidPrice: binanceMid,
          priceVsBinanceBps: null,
        } as Awaited<ReturnType<typeof previewOneInchSwap>>
      }
    })(),
  ])

  const dexGasUsd = input.side === 'BUY' ? env.smartRouterDexGasUsdBuy : env.smartRouterDexGasUsdSell
  const dexAvailable = Boolean(dexPreview?.tradable && dexPreview.executablePrice != null)
  const dexExtraUsd = dexAvailable ? dexGasUsd : 0

  const binanceSummary: VenueQuoteSummary = {
    venue: 'binance',
    available: binanceQ.available,
    reason: binanceQ.reason,
    executablePrice: binanceQ.executablePrice,
    amountInHuman: binanceQ.amountInHuman,
    amountOutHuman: binanceQ.amountOutHuman,
    extraCostUsd: 0,
    priceVsBinanceMidBps: bpsVsMid(binanceQ.executablePrice, binanceMid, input.side),
  }

  const oneinchSummary: VenueQuoteSummary = {
    venue: 'oneinch_bsc',
    available: dexAvailable,
    reason: dexAvailable ? undefined : (dexPreview?.message ?? '1inch or personal wallet unavailable'),
    executablePrice: dexPreview?.executablePrice ?? null,
    amountInHuman: dexPreview?.amountInHuman ?? input.amount,
    amountOutHuman: dexPreview?.amountOutHuman ?? 0,
    extraCostUsd: dexExtraUsd,
    priceVsBinanceMidBps: dexPreview?.priceVsBinanceBps ?? null,
  }

  const { venue, savingsBps, savingsUsd } = pickWinner(input.side, binanceSummary, oneinchSummary)

  if (venue === 'binance') {
    oneinchSummary.extraCostUsd = Math.max(0, savingsUsd)
    binanceSummary.extraCostUsd = 0
  } else if (venue === 'oneinch_bsc') {
    binanceSummary.extraCostUsd = Math.max(0, savingsUsd)
    oneinchSummary.extraCostUsd = dexExtraUsd
  }

  let blockTrade = false
  let blockReason: string | undefined
  if (!venue) {
    blockTrade = true
    blockReason =
      input.side === 'BUY'
        ? 'No venue available — connect Binance keys and/or create a personal wallet with USDT on BSC.'
        : 'No venue available for this sell.'
  } else {
    const winner = venue === 'binance' ? binanceSummary : oneinchSummary
    const vsMid = winner.priceVsBinanceMidBps
    if (
      input.side === 'BUY' &&
      vsMid != null &&
      vsMid > env.smartRouterMaxBuyVsBinanceBps
    ) {
      blockTrade = true
      blockReason = `Best venue is still ${(vsMid / 100).toFixed(2)}% above Binance mid — wait for a better quote or use a more liquid pair.`
    }
    if (input.side === 'BUY' && input.amount < env.smartRouterMinUsdt) {
      blockTrade = true
      blockReason = `Minimum trade size is ${env.smartRouterMinUsdt} USDT.`
    }
  }

  return {
    binanceSymbol,
    side: input.side,
    amount: input.amount,
    binanceMid,
    venues: { binance: binanceSummary, oneinch: oneinchSummary },
    recommended: venue,
    savingsVsOtherBps: savingsBps,
    savingsVsOtherUsd: savingsUsd,
    blockTrade,
    blockReason,
  }
}

export async function executeSmartTrade(
  userId: string,
  input: {
    binanceSymbol: string
    side: 'BUY' | 'SELL'
    amount: number
    slippageBps?: number
    /** Force a venue (otherwise uses recommended). */
    venue?: ExecutionVenue
  },
): Promise<SmartExecutionResult> {
  const quote = await getSmartExecutionQuote(userId, input)
  if (quote.blockTrade) {
    throw new Error(quote.blockReason ?? 'Trade blocked by smart router')
  }
  const venue = input.venue ?? quote.recommended
  if (!venue) throw new Error(quote.blockReason ?? 'No execution venue available')

  if (venue === 'binance') {
    const r = await executeBinanceSpotTrade(userId, input)
    return {
      venue: 'binance',
      binanceSymbol: input.binanceSymbol,
      side: input.side,
      orderId: r.orderId,
      trade: r.trade,
    }
  }

  const r = await executeOneInchSwap(userId, {
    side: input.side,
    binanceSymbol: input.binanceSymbol,
    amount: input.amount,
    slippageBps: input.slippageBps,
  })
  return {
    venue: 'oneinch_bsc',
    binanceSymbol: input.binanceSymbol,
    side: input.side,
    txHash: r.txHash,
    trade: r.trade,
  }
}
