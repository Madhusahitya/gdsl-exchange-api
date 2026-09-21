/**
 * Manual trading desk for Jupiter (Solana).
 *
 * Super Machine trades on its own; this is the path for a user who wants to
 * size the trade themselves but still see what the council sees and, more
 * importantly, be told up front what the trade has to do to make money.
 *
 * On a DEX the round-trip spread is the dominant cost and it is invisible in a
 * single quote: a token can look flat while the buy ask sits 4% above the sell
 * bid, so an "even" trade is an instant loss. Every check here is framed around
 * that — what price the token must reach before the exit is profitable.
 *
 * The desk works for both custody models. Pass `owner` and balances come from
 * that connected wallet; omit it and they come from the platform wallet.
 */
import { PublicKey } from '@solana/web3.js'
import { logger } from '../../lib/logger'
import { SOL_NATIVE_MINT, SOL_USDC_MINT } from '../../lib/solDexCatalog'
import {
  getSolanaTokenBalance,
  getSolanaWalletStatus,
  listSolanaHoldingsForOwner,
} from '../wallet/solanaPersonalWalletService'
import { getMarketContext, type MarketContext } from '../market/marketContextService'
import { getJupiterTradableToken } from './jupiterTradableRegistry'
import { previewJupiterSwap, type JupiterQuotePreview } from './jupiterSwapService'
import { getJupiterExitSettings } from './jupiterExitSettingsService'

export type DeskSide = 'BUY' | 'SELL'

/** SOL kept back for network + ATA rent on every swap. */
const SOL_GAS_RESERVE = 0.003
/** Below this the DEX spread eats the trade regardless of direction. */
const MIN_TRADE_USD = 1
/** A round-trip spread above this makes a quick flip structurally unprofitable. */
const WIDE_SPREAD_BPS = 250

export type JupiterDesk = {
  binanceSymbol: string
  pair: string
  baseSymbol: string
  wallet: {
    source: 'platform' | 'browser'
    address: string | null
    /** True when the bot can sign, i.e. take-profit / stop-loss can run. */
    botCanTrade: boolean
    sol: number
    usdc: number
    baseQty: number
  }
  price: {
    buy: number | null
    sell: number | null
    /** Round-trip spread in bps — the cost of a buy-then-sell at current quotes. */
    spreadBps: number | null
  }
  /** What the position must do to make money, straight from the quote engine. */
  profit: {
    breakEvenSellPrice: number | null
    minMoveToBreakEvenPct: number | null
    upsideToBreakEvenPct: number | null
    openEntryPrice: number | null
    estNetPnlUsd: number | null
    entryQuality: 'good' | 'caution' | 'poor' | null
    entryQualityNote: string | null
  }
  exits: { takeProfitPct: number; stopLossPct: number; takeProfitPrice: number | null; stopLossPrice: number | null }
  context: MarketContext | null
  suggestion: {
    action: DeskSide | 'WAIT'
    sizeUsd: number
    conviction: number
    reasons: string[]
    cautions: string[]
  }
  updatedAt: string
}

export type JupiterPreflight = {
  ok: boolean
  blockers: string[]
  warnings: string[]
  /** Plain-language statement of what has to happen for this trade to profit. */
  profitCase: string | null
  order: {
    side: DeskSide
    binanceSymbol: string
    pair: string
    amount: number
    spendSymbol: string
    estPrice: number | null
    estReceive: number | null
    estValueUsd: number | null
    breakEvenSellPrice: number | null
    minMoveToBreakEvenPct: number | null
    spreadBps: number | null
    priceImpactPct: number | null
  }
  signalAlignment: 'with' | 'against' | 'neutral'
}

function normalizeSymbol(raw: string): string {
  return raw.replace('/', '').toUpperCase()
}

/** Balances for whichever wallet the desk is reporting on. */
async function loadWallet(
  userId: string,
  owner: string | undefined,
  tokenMint: string,
  tokenDecimals: number,
): Promise<JupiterDesk['wallet']> {
  if (owner?.trim()) {
    let pk: PublicKey
    try {
      pk = new PublicKey(owner.trim())
    } catch {
      throw new Error('Invalid Solana wallet address')
    }
    const holdings = await listSolanaHoldingsForOwner(pk).catch((err) => {
      logger.warn({ err, owner }, '[jupiter-desk] connected wallet read failed')
      return []
    })
    const amountOf = (mint: string) => holdings.find((h) => h.mint === mint)?.amount ?? 0
    return {
      source: 'browser',
      address: pk.toBase58(),
      botCanTrade: false,
      sol: amountOf(SOL_NATIVE_MINT),
      usdc: amountOf(SOL_USDC_MINT),
      baseQty: amountOf(tokenMint),
    }
  }

  const status = await getSolanaWalletStatus(userId).catch(() => null)
  const [sol, usdc, baseQty] = await Promise.all([
    getSolanaTokenBalance(userId, SOL_NATIVE_MINT, 9).catch(() => 0),
    getSolanaTokenBalance(userId, SOL_USDC_MINT, 6).catch(() => 0),
    getSolanaTokenBalance(userId, tokenMint, tokenDecimals).catch(() => 0),
  ])
  return {
    source: 'platform',
    address: status?.wallet?.address ?? null,
    botCanTrade: true,
    sol,
    usdc,
    baseQty,
  }
}

/**
 * The desk view: balances, live two-sided pricing, the break-even the trade has
 * to clear, higher-timeframe context, and a sized suggestion.
 */
export async function getJupiterDesk(opts: {
  userId: string
  binanceSymbol: string
  /** Connected wallet address; omit to report on the platform wallet. */
  owner?: string
  /** Probe size used for the two-sided quote. Defaults to a small clip. */
  probeUsd?: number
}): Promise<JupiterDesk> {
  const binanceSymbol = normalizeSymbol(opts.binanceSymbol)
  const token = await getJupiterTradableToken(binanceSymbol)
  if (!token) throw new Error(`${binanceSymbol} is not tradable on Solana via Jupiter.`)

  const baseSymbol = token.baseSymbol
  const pair = `${baseSymbol}/USDT`
  const probeUsd = Math.min(500, Math.max(MIN_TRADE_USD, opts.probeUsd ?? 25))

  const [wallet, exits, quote, context] = await Promise.all([
    loadWallet(opts.userId, opts.owner, token.mint, token.decimals),
    getJupiterExitSettings(opts.userId),
    previewJupiterSwap(
      { side: 'BUY', binanceSymbol, amount: probeUsd, spendMint: SOL_USDC_MINT },
      { userId: opts.userId, skipEntryGuard: true },
    ).catch((err) => {
      logger.warn({ err, binanceSymbol }, '[jupiter-desk] quote probe failed')
      return null
    }),
    // Memecoins have no Binance listing, so no stored candles — that is expected
    // and the context simply reports itself unavailable.
    getMarketContext(binanceSymbol).catch(() => null),
  ])

  const buy = quote?.jupiterBuyPrice ?? null
  const sell = quote?.jupiterSellPrice ?? null
  const spreadBps = quote?.roundTripSpreadBps ?? null

  const takeProfitPct = Number(exits.takeProfitPct ?? 10)
  const stopLossPct = Number(exits.stopLossPct ?? 5)
  const entryRef = quote?.openEntryPrice ?? buy

  const reasons: string[] = []
  const cautions: string[] = []

  if (context?.available) reasons.push(context.headline)
  if (quote?.entryQualityNote) reasons.push(quote.entryQualityNote)

  const absSpread = spreadBps != null ? Math.abs(spreadBps) : null
  if (absSpread != null && absSpread > WIDE_SPREAD_BPS) {
    cautions.push(
      `Round-trip spread is ${(absSpread / 100).toFixed(2)}% — price must rise that much before an exit breaks even.`,
    )
  }
  if (quote?.minMoveToBreakEvenPct != null && quote.minMoveToBreakEvenPct > 0) {
    reasons.push(`Needs +${quote.minMoveToBreakEvenPct.toFixed(2)}% after entry to break even on the exit.`)
  }
  if (quote?.entryQuality === 'poor') cautions.push('Entry quality is poor at this size — try a smaller clip.')
  if (context?.regime === 'high_volatility') cautions.push('High volatility regime — size down.')
  if (context?.regime === 'choppy') cautions.push('Choppy regime — trend signals are unreliable here.')
  if (context?.longHorizon?.trend === 'bear') cautions.push('Token is in a 1-year downtrend.')
  if (wallet.sol < SOL_GAS_RESERVE) {
    cautions.push(`Only ${wallet.sol.toFixed(4)} SOL for fees — top up to about ${SOL_GAS_RESERVE} SOL.`)
  }
  if (wallet.usdc < MIN_TRADE_USD) cautions.push(`USDC balance $${wallet.usdc.toFixed(2)} is below the minimum trade.`)
  if (!wallet.botCanTrade) {
    cautions.push('Connected wallet — take-profit and stop-loss are alerts here, not automatic sells.')
  }

  // Conviction leans on higher-timeframe agreement, then discounts for the
  // spread the trade has to overcome before it can profit.
  const alignment = context?.available ? context.alignment.score : 0
  const spreadPenalty = absSpread != null ? Math.min(0.4, absSpread / 1_000) : 0.1
  const qualityBonus = quote?.entryQuality === 'good' ? 0.15 : quote?.entryQuality === 'poor' ? -0.2 : 0
  const conviction = Math.max(0, Math.min(0.95, 0.35 + (alignment + 1) / 2 * 0.4 + qualityBonus - spreadPenalty))

  const hasOpen = (quote?.openEntryPrice ?? 0) > 0
  let action: JupiterDesk['suggestion']['action'] = 'WAIT'
  if (hasOpen && quote?.upsideToBreakEvenPct === 0 && (context?.alignment.score ?? 0) <= 0) {
    // In profit and momentum is rolling over — a reasonable place to take it.
    action = 'SELL'
  } else if (
    !hasOpen &&
    conviction >= 0.5 &&
    quote?.entryQuality !== 'poor' &&
    wallet.usdc >= MIN_TRADE_USD &&
    wallet.sol >= SOL_GAS_RESERVE
  ) {
    action = 'BUY'
  }

  const spendable = Math.max(0, wallet.usdc * 0.95)
  const sizeUsd = action === 'BUY' ? Math.floor(Math.min(spendable, spendable * conviction) * 100) / 100 : 0

  return {
    binanceSymbol,
    pair,
    baseSymbol,
    wallet,
    price: { buy, sell, spreadBps },
    profit: {
      breakEvenSellPrice: quote?.breakEvenSellPrice ?? null,
      minMoveToBreakEvenPct: quote?.minMoveToBreakEvenPct ?? null,
      upsideToBreakEvenPct: quote?.upsideToBreakEvenPct ?? null,
      openEntryPrice: quote?.openEntryPrice ?? null,
      estNetPnlUsd: quote?.estNetPnlUsd ?? null,
      entryQuality: quote?.entryQuality ?? null,
      entryQualityNote: quote?.entryQualityNote ?? null,
    },
    exits: {
      takeProfitPct,
      stopLossPct,
      takeProfitPrice: entryRef != null ? entryRef * (1 + takeProfitPct / 100) : null,
      stopLossPrice: entryRef != null ? entryRef * (1 - stopLossPct / 100) : null,
    },
    context,
    suggestion: {
      action,
      sizeUsd,
      conviction,
      reasons: reasons.filter(Boolean).slice(0, 4),
      cautions: cautions.slice(0, 4),
    },
    updatedAt: new Date().toISOString(),
  }
}

/** Human-readable statement of what the trade must do to make money. */
function describeProfitCase(
  side: DeskSide,
  baseSymbol: string,
  quote: JupiterQuotePreview | null,
  amountUsd: number | null,
): string | null {
  if (side === 'SELL') {
    if (quote?.upsideToBreakEvenPct == null) return null
    return quote.upsideToBreakEvenPct === 0
      ? `Selling now clears your entry plus fees${
          quote.estNetPnlUsd != null ? ` — about $${quote.estNetPnlUsd.toFixed(2)} net.` : '.'
        }`
      : `Selling now books a loss: ${baseSymbol} is still ${quote.upsideToBreakEvenPct.toFixed(
          2,
        )}% below your break-even price.`
  }

  const move = quote?.minMoveToBreakEvenPct
  if (move == null) return null
  const target = quote?.breakEvenSellPrice
  const size = amountUsd != null && amountUsd > 0 ? `$${amountUsd.toFixed(2)} ` : ''
  return (
    `On this ${size}buy, ${baseSymbol} must rise ${move.toFixed(2)}%` +
    (target != null ? ` (to about ${target.toPrecision(6)} USDC)` : '') +
    ' before selling turns a profit. That gap is the DEX spread plus network fees.'
  )
}

/**
 * Dry run for a manual Jupiter order: everything that would reject it, plus a
 * plain statement of the profit case. Safe to call on every keystroke.
 */
export async function previewJupiterManualTrade(opts: {
  userId: string
  binanceSymbol: string
  side: DeskSide
  amount: number
  slippageBps?: number
  spendMint?: string
  owner?: string
}): Promise<JupiterPreflight> {
  const binanceSymbol = normalizeSymbol(opts.binanceSymbol)
  const token = await getJupiterTradableToken(binanceSymbol)
  if (!token) throw new Error(`${binanceSymbol} is not tradable on Solana via Jupiter.`)

  const baseSymbol = token.baseSymbol
  const pair = `${baseSymbol}/USDT`
  const spendMint = opts.side === 'BUY' ? (opts.spendMint?.trim() || SOL_USDC_MINT) : token.mint
  const isNativeSpend = spendMint === SOL_NATIVE_MINT
  const spendSymbol =
    opts.side === 'SELL' ? baseSymbol : isNativeSpend ? 'SOL' : spendMint === SOL_USDC_MINT ? 'USDC' : 'token'

  const [wallet, quote, context] = await Promise.all([
    loadWallet(opts.userId, opts.owner, token.mint, token.decimals),
    previewJupiterSwap(
      {
        side: opts.side,
        binanceSymbol,
        amount: opts.amount,
        slippageBps: opts.slippageBps,
        spendMint: opts.side === 'BUY' ? spendMint : undefined,
      },
      { userId: opts.userId, skipEntryGuard: true },
    ).catch(() => null),
    getMarketContext(binanceSymbol).catch(() => null),
  ])

  const blockers: string[] = []
  const warnings: string[] = []

  if (!Number.isFinite(opts.amount) || opts.amount <= 0) {
    blockers.push(opts.side === 'BUY' ? 'Enter how much to spend.' : `Enter how much ${baseSymbol} to sell.`)
  }
  if (quote && quote.tradable === false) {
    blockers.push(quote.message ?? `No executable Jupiter route for ${pair}.`)
  }

  const estPrice = opts.side === 'BUY' ? (quote?.jupiterBuyPrice ?? null) : (quote?.jupiterSellPrice ?? null)
  if (quote != null && estPrice == null) blockers.push(`No live ${baseSymbol} price from Jupiter right now.`)

  // Fees come out of the same wallet that signs, whichever custody model it is.
  if (wallet.sol < SOL_GAS_RESERVE) {
    blockers.push(
      `Needs about ${SOL_GAS_RESERVE} SOL for network fees — ${
        wallet.source === 'browser' ? 'your connected wallet' : 'your trading wallet'
      } has ${wallet.sol.toFixed(4)} SOL.`,
    )
  }

  let estReceive: number | null
  let estValueUsd: number | null

  if (opts.side === 'BUY') {
    const available = isNativeSpend ? Math.max(0, wallet.sol - SOL_GAS_RESERVE) : wallet.usdc
    if (opts.amount > available) {
      blockers.push(
        `Balance is ${available.toFixed(isNativeSpend ? 4 : 2)} ${spendSymbol} — not enough for a ${opts.amount} ${spendSymbol} buy.`,
      )
    }
    // USD sizing only equals the amount when spending a dollar-pegged asset.
    estValueUsd = spendMint === SOL_USDC_MINT ? opts.amount : null
    if (estValueUsd != null && estValueUsd < MIN_TRADE_USD) {
      blockers.push(`Minimum trade is $${MIN_TRADE_USD}.`)
    }
    estReceive = estPrice != null && estPrice > 0 ? opts.amount / estPrice : null
  } else {
    if (opts.amount > wallet.baseQty) {
      blockers.push(`You hold ${wallet.baseQty} ${baseSymbol} — cannot sell ${opts.amount}.`)
    }
    estReceive = estPrice != null ? opts.amount * estPrice : null
    estValueUsd = estReceive
    if (estValueUsd != null && estValueUsd < MIN_TRADE_USD) {
      warnings.push(`Sale is only about $${estValueUsd.toFixed(2)} — fees will take a large share.`)
    }
  }

  const spreadBps = quote?.roundTripSpreadBps ?? null
  const absSpread = spreadBps != null ? Math.abs(spreadBps) : null
  if (opts.side === 'BUY' && absSpread != null && absSpread > WIDE_SPREAD_BPS) {
    warnings.push(
      `Round-trip spread is ${(absSpread / 100).toFixed(2)}%. A quick flip loses money unless the price moves more than that.`,
    )
  }
  if (quote?.entryQuality === 'poor' && quote.entryQualityNote) warnings.push(quote.entryQualityNote)
  if (quote?.estRoundTripLossUsd != null && quote.estRoundTripLossUsd < -0.5 && opts.side === 'BUY') {
    warnings.push(
      `Buying and selling immediately at current quotes would lose about $${Math.abs(
        quote.estRoundTripLossUsd,
      ).toFixed(2)}.`,
    )
  }

  if (opts.side === 'SELL' && quote?.upsideToBreakEvenPct != null && quote.upsideToBreakEvenPct > 0) {
    warnings.push(
      `This exit is ${quote.upsideToBreakEvenPct.toFixed(2)}% below break-even — you would realise a loss.`,
    )
  }

  if (!wallet.botCanTrade) {
    warnings.push('Self-custody trade: take-profit and stop-loss will be alerts, not automatic sells.')
  }

  let signalAlignment: JupiterPreflight['signalAlignment'] = 'neutral'
  if (context?.available) {
    const score = context.alignment.score
    if (opts.side === 'BUY') {
      if (score >= 0.4) signalAlignment = 'with'
      else if (score <= -0.4) {
        signalAlignment = 'against'
        warnings.push(`${context.alignment.bearish}/${context.alignment.total} higher timeframes are bearish.`)
      }
      if (context.longHorizon != null && context.longHorizon.pctFromHigh52w > -2) {
        warnings.push('Buying at 52-week highs — confirm this is a breakout, not exhaustion.')
      }
    } else if (score >= 0.4) {
      signalAlignment = 'against'
      warnings.push(`${context.alignment.bullish}/${context.alignment.total} higher timeframes still read bullish.`)
    } else {
      signalAlignment = 'with'
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    profitCase: describeProfitCase(opts.side, baseSymbol, quote, estValueUsd),
    order: {
      side: opts.side,
      binanceSymbol,
      pair,
      amount: opts.amount,
      spendSymbol,
      estPrice,
      estReceive,
      estValueUsd,
      breakEvenSellPrice: quote?.breakEvenSellPrice ?? null,
      minMoveToBreakEvenPct: quote?.minMoveToBreakEvenPct ?? null,
      spreadBps,
      priceImpactPct: quote?.priceImpactPct ?? null,
    },
    signalAlignment,
  }
}
