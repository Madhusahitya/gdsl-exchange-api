/**
 * Jupiter Swap API v2 swaps via the user's Solana personal wallet (server-signed).
 * Isolated strategy book: DEX Jupiter SOL.
 */
import { VersionedTransaction } from '@solana/web3.js'
import { prisma, TradeStatus } from '@cryptoflow/db'
import { logger } from '../../lib/logger'
import { env } from '../../lib/env'
import {
  estimatedNetRoundTripUsd,
  roundTripRealizedPnl,
  SOLANA_DEX_ROUND_TRIP_FEE_USD,
} from '../../lib/roundTripPnl'
import { SOL_USDC_MINT, SOL_NATIVE_MINT } from '../../lib/solDexCatalog'
import { CONVERT_FEE_USD, feeTreasurySol } from '../../lib/feeTreasury'
import {
  ensureSolanaPersonalWallet,
  getSolanaKeypair,
  getSolanaMintDecimals,
  getSolanaTokenBalance,
  isSolanaWalletEnabled,
  listSolanaHoldings,
  sendSolanaTokenFromUser,
} from '../wallet/solanaPersonalWalletService'
import { hydrateSolTokenDecimals, type ResolvedSolToken } from './solTokenResolver'
import { getJupiterTradableToken } from './jupiterTradableRegistry'
import {
  submitJupiterExecute,
  getJupiterOrder,
  isJupiterConfigured,
  isJupiterSwapRateLimited,
} from './jupiterClassicService'
import { fetchJupiterPricesV3 } from './jupiterPriceService'
import { getJupiterExecutableMarks, quoteJupiterSellUsdPerToken, fetchBinanceBookMid } from './jupiterMarkService'
import { maybeCreditJupiterReferralVolume } from './jupiterReferralVolumeService'
import { getJupiterExitSettings } from './jupiterExitSettingsService'
import { pickBestJupiterDexFilter } from './executionEngineService'

const MIN_USDC_TRADE = 50
/** Absolute floor for a BUY notional (USD). Below this Jupiter dust routes fail. */
const MIN_BUY_NOTIONAL_USD = 1
/** SOL kept untouched for network/ATA fees when spending native SOL. */
const SOL_GAS_RESERVE = 0.003
/** Minimum native SOL before assembling a Jupiter taker transaction. */
const MIN_SOL_FOR_SWAP = 0.008
/** USDC spent to auto-buy SOL gas when the wallet is empty (covers ~a few swaps). */
const GAS_TOPUP_USDC = 1.0

/**
 * Jupiter `/order?taker=` needs native SOL for fees. Quote-only works with 0 SOL,
 * but sell/buy with a taker returns the opaque "Failed to get quotes". When SOL is
 * low, buy a little SOL from USDC (that route works even at 0 SOL balance).
 */
async function ensureSolanaSwapGas(userId: string): Promise<void> {
  const sol = await getSolanaTokenBalance(userId, SOL_NATIVE_MINT, 9)
  if (sol >= MIN_SOL_FOR_SWAP) return

  const usdc = await getSolanaTokenBalance(userId, SOL_USDC_MINT, 6)
  const topUpUsd = Math.min(GAS_TOPUP_USDC, Math.max(0.4, Math.min(usdc, GAS_TOPUP_USDC)))
  if (usdc < 0.4) {
    throw new Error(
      `Solana wallet needs ~0.01 SOL for network fees (have ${sol.toFixed(4)} SOL and $${usdc.toFixed(2)} USDC). ` +
        `Deposit a little SOL, or keep at least $0.40 USDC so the bot can auto-buy gas.`,
    )
  }

  const kp = await getSolanaKeypair(userId)
  const taker = kp.publicKey.toBase58()
  const amountIn = toSmallest(topUpUsd, 6)
  let order
  try {
    order = await getJupiterOrder({
      inputMint: SOL_USDC_MINT,
      outputMint: SOL_NATIVE_MINT,
      amount: amountIn,
      taker,
      slippageBps: 300,
    })
  } catch (err) {
    throw new Error(
      `Could not auto-buy SOL for gas (${err instanceof Error ? err.message : 'quote failed'}). ` +
        `Deposit ~0.01 SOL to ${taker.slice(0, 4)}…${taker.slice(-4)} and retry.`,
    )
  }
  if (!order.transaction) {
    throw new Error(
      `Could not auto-buy SOL for gas. Deposit ~0.01 SOL to ${taker.slice(0, 4)}…${taker.slice(-4)} and retry.`,
    )
  }

  const vtx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'))
  vtx.sign([kp])
  const executed = await submitJupiterExecute({
    signedTransaction: Buffer.from(vtx.serialize()).toString('base64'),
    requestId: order.requestId,
  })
  if (!executed.signature) {
    throw new Error('Auto gas top-up (USDC→SOL) did not confirm — deposit ~0.01 SOL and retry.')
  }
  logger.info(
    { userId, topUpUsd, solBefore: sol, signature: executed.signature },
    '[jupiter] auto gas top-up USDC→SOL',
  )
}

/** Assets a user can spend on a Jupiter BUY. USDC is the default stable. */
export const JUPITER_SPEND_ASSETS = ['USDC', 'SOL'] as const
export type JupiterSpendAsset = (typeof JUPITER_SPEND_ASSETS)[number]
const SPEND_ASSET_MINTS: Record<JupiterSpendAsset, { mint: string; decimals: number }> = {
  USDC: { mint: SOL_USDC_MINT, decimals: 6 },
  SOL: { mint: SOL_NATIVE_MINT, decimals: 9 },
}

export type SpendMintInfo = {
  mint: string
  decimals: number
  /** USD value of one unit (USDC = 1; others priced live). 0 if unpriceable. */
  usdPerUnit: number
  isNativeSol: boolean
}

/**
 * Resolve the BUY pay-with token. An explicit `spendMint` (any token the user
 * holds) wins; otherwise fall back to the legacy USDC/SOL `spendAsset`. Decimals
 * come from chain, price from Jupiter — so all PnL/guard math stays in USD no
 * matter what the user spends.
 */
async function resolveSpendMint(opts: {
  spendMint?: string
  spendAsset?: JupiterSpendAsset
}): Promise<SpendMintInfo> {
  const explicit = opts.spendMint?.trim()
  const mint = explicit && explicit.length > 0 ? explicit : SPEND_ASSET_MINTS[opts.spendAsset ?? 'USDC'].mint
  const isNativeSol = mint === SOL_NATIVE_MINT

  let decimals: number
  if (mint === SOL_USDC_MINT) decimals = 6
  else if (isNativeSol) decimals = 9
  else decimals = await getSolanaMintDecimals(mint)

  let usdPerUnit: number
  if (mint === SOL_USDC_MINT) {
    usdPerUnit = 1
  } else {
    const map = await fetchJupiterPricesV3([mint])
    const px = map.get(mint)?.usdPrice
    usdPerUnit = px && px > 0 ? px : 0
  }
  return { mint, decimals, usdPerUnit, isNativeSol }
}
/** Reject buys when executable ask is worse than Jupiter mid by more than this (bps). */
const MAX_BUY_VS_JUPITER_MID_BPS = 90
/** Reject sells when Jupiter bid is worse than Jupiter mid by more than this (bps below mid). */
const MAX_SELL_VS_JUPITER_MID_BPS = 90
/** Block BUY when instant round-trip spread is worse than this (bps below zero). */
const MAX_BUY_ROUND_TRIP_SPREAD_BPS = 80
/** Warn (caution) when round-trip spread is worse than this but above block threshold. */
const CAUTION_BUY_ROUND_TRIP_SPREAD_BPS = 40
/** Block BUY when price must rise more than this % just to break even after spread + fees. */
const MAX_MIN_MOVE_TO_BREAK_EVEN_PCT = 1.2
/** Hard cap on sell quote/trade notional — prevents accidental "50 BTC" style quotes. */
const MAX_SELL_NOTIONAL_USD = 25_000
export const JUPITER_STRATEGY_NAME = 'DEX Jupiter SOL'

function tokenQtyForUsdNotional(usd: number, usdPerToken: number | null, decimals: number): number {
  if (!usdPerToken || usdPerToken <= 0) return 0
  const raw = usd / usdPerToken
  const factor = 10 ** Math.min(decimals, 8)
  return Math.floor(raw * factor) / factor
}

/** Reject fill prices that still diverge wildly from Jupiter mark after on-chain decimals. */
async function reconcileFillPriceWithMark(
  mint: string,
  fillPrice: number,
  side: 'BUY' | 'SELL',
): Promise<number> {
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) return fillPrice
  try {
    const prices = await fetchJupiterPricesV3([mint])
    const mark = prices.get(mint)?.usdPrice
    if (!mark || mark <= 0) return fillPrice
    const ratio = fillPrice / mark
    if (ratio > 4 || ratio < 0.25) {
      logger.error(
        { mint, fillPrice, mark, side, ratio },
        '[jupiter] fill price implausible vs Jupiter mark — clamping to mark for trade log',
      )
      return mark
    }
  } catch (err) {
    logger.warn({ err, mint }, '[jupiter] fill price mark check failed')
  }
  return fillPrice
}

async function ensureJupiterStrategyId(): Promise<string> {
  const strategy = await prisma.strategy.upsert({
    where: { name: JUPITER_STRATEGY_NAME },
    update: {},
    create: {
      name: JUPITER_STRATEGY_NAME,
      description: 'Manual swaps via Jupiter Ultra / Swap API v2 on Solana mainnet.',
      riskLevel: 'MEDIUM',
    },
    select: { id: true },
  })
  return strategy.id
}

async function getJupiterOpenEntry(
  userId: string,
  baseSymbol: string,
): Promise<{ avgEntry: number; totalAllocUsd: number } | null> {
  const strategyId = await ensureJupiterStrategyId()
  const pair = `${baseSymbol.toUpperCase()}/USDT`
  const opens = await prisma.trade.findMany({
    where: { userId, pair, strategyId, status: TradeStatus.OPEN },
    select: { entryPrice: true, allocationUsd: true },
  })
  if (opens.length === 0) return null
  let totalAlloc = 0
  let weightedEntry = 0
  for (const t of opens) {
    const alloc = Number(t.allocationUsd ?? 0)
    const entry = Number(t.entryPrice)
    if (alloc > 0 && entry > 0) {
      totalAlloc += alloc
      weightedEntry += entry * alloc
    }
  }
  if (totalAlloc <= 0) return null
  return { avgEntry: weightedEntry / totalAlloc, totalAllocUsd: totalAlloc }
}

export type JupiterOpenPosition = {
  baseSymbol: string
  binanceSymbol: string
  mint: string
  avgEntry: number
  qty: number
  totalAllocUsd: number
  /** Live Jupiter sell (bid) price for this position size — what you'd actually receive. */
  liveSellPrice: number | null
  /** Unified Jupiter mid — same as chart headline (bid+ask)/2. */
  liveMidPrice: number | null
  /** qty × live bid: current liquidation value in USDC. */
  currentValueUsd: number | null
  /** Net USDC PnL if sold now (after spread, slippage, Solana fees). */
  estNetPnlUsd: number | null
  /** Exit price needed to clear entry + costs + min target profit. */
  breakEvenSellPrice: number | null
  /** % the live bid must still rise to reach break-even (0 if already profitable). */
  upsideToBreakEvenPct: number | null
  /** Live bid vs avg entry, %. */
  priceVsEntryPct: number | null
  /** True when selling now nets at/above the min profit target. */
  inProfit: boolean
  /** USDC already banked via profit-skim while this lot stays OPEN (in Solana wallet). */
  bankedSkimUsd: number
  /** Effective take-profit % (per-position override or the user's global setting). */
  takeProfitPct: number
  /** Effective stop-loss % (per-position override or the user's global setting). */
  stopLossPct: number
  /** Effective trailing-stop flag for this lot. */
  trailingStop: boolean
  /** Raw per-position overrides — null means "inherits the global exit settings". */
  exitOverrides: {
    takeProfitPct: number | null
    stopLossPct: number | null
    trailingStop: boolean | null
  }
}

/** Don't reconcile OPEN lots until Solana RPC usually reflects a fresh fill. */
const RECONCILE_GRACE_MS = 5 * 60_000
/** Book qty can exceed wallet after duplicate-submit bugs; downscale when gap > 15%. */
const OVERBOOK_DOWNSCALE_RATIO = 0.85

/** Prevent parallel duplicate BUYs for the same pair (double-click / SM + manual race). */
const jupiterBuyInFlight = new Map<string, number>()
const BUY_IN_FLIGHT_MS = 45_000

/**
 * Collapse duplicate OPEN rows for the same pair into one weighted lot.
 * Keeps the oldest row; extras become CANCELLED (bookkeeping only — wallet qty unchanged).
 */
export async function mergeDuplicateJupiterOpenTrades(userId: string): Promise<number> {
  const strategyId = await ensureJupiterStrategyId()
  const opens = await prisma.trade.findMany({
    where: { userId, strategyId, status: TradeStatus.OPEN },
    orderBy: { createdAt: 'asc' },
  })
  if (opens.length < 2) return 0

  const byPair = new Map<string, typeof opens>()
  for (const t of opens) {
    const list = byPair.get(t.pair) ?? []
    list.push(t)
    byPair.set(t.pair, list)
  }

  let cancelled = 0
  for (const trades of byPair.values()) {
    if (trades.length <= 1) continue
    const primary = trades[0]!
    let totalAlloc = 0
    let weightedEntry = 0
    let bankedSkim = 0
    for (const t of trades) {
      const alloc = Number(t.allocationUsd ?? 0)
      const entry = Number(t.entryPrice)
      if (alloc > 0 && entry > 0) {
        totalAlloc += alloc
        weightedEntry += entry * alloc
      }
      const skim = Number(t.pnl ?? 0)
      if (Number.isFinite(skim) && skim > 0) bankedSkim += skim
    }
    const avgEntry =
      totalAlloc > 0 && weightedEntry > 0
        ? weightedEntry / totalAlloc
        : Number(primary.entryPrice)
    await prisma.trade.update({
      where: { id: primary.id },
      data: {
        allocationUsd: totalAlloc > 0 ? totalAlloc : primary.allocationUsd,
        entryPrice: avgEntry,
        ...(bankedSkim > 0 ? { pnl: bankedSkim } : {}),
      },
    })
    const extraIds = trades.slice(1).map((t) => t.id)
    if (extraIds.length === 0) continue
    await prisma.trade.updateMany({
      where: { id: { in: extraIds }, status: TradeStatus.OPEN },
      data: { status: TradeStatus.CANCELLED },
    })
    cancelled += extraIds.length
  }

  if (cancelled > 0) {
    logger.info({ userId, cancelled }, '[jupiter] merged duplicate OPEN rows into primary lot')
  }
  return cancelled
}

/** Same-pair duplicate-submit bursts (e.g. 3× $42 logged, one fill). */
const BURST_DEDUPE_MS = 3 * 60_000

/**
 * Correct CLOSED/OPEN rows whose allocationUsd was inflated when duplicate BUY
 * submits were merged (e.g. trade log shows $126 but only one ~$42 fill landed).
 */
export async function reconcileInflatedJupiterBurstTrades(userId: string): Promise<number> {
  const strategyId = await ensureJupiterStrategyId()
  const trades = await prisma.trade.findMany({
    where: { userId, strategyId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      pair: true,
      status: true,
      allocationUsd: true,
      pnl: true,
      exitPrice: true,
      createdAt: true,
    },
  })
  if (trades.length < 2) return 0

  let fixed = 0
  let i = 0
  while (i < trades.length) {
    const anchor = trades[i]!
    const burst = [anchor]
    let j = i + 1
    while (j < trades.length) {
      const t = trades[j]!
      if (t.pair !== anchor.pair) break
      const gap = t.createdAt.getTime() - burst[burst.length - 1]!.createdAt.getTime()
      if (gap > BURST_DEDUPE_MS) break
      burst.push(t)
      j++
    }

    if (burst.length >= 2) {
      const cancelled = burst.filter((t) => t.status === TradeStatus.CANCELLED)
      const primary = burst.find(
        (t) =>
          t.status === TradeStatus.OPEN ||
          (t.status === TradeStatus.CLOSED && t.exitPrice != null),
      )
      if (cancelled.length >= 1 && primary) {
        const unitAllocs = cancelled
          .map((t) => Number(t.allocationUsd ?? 0))
          .filter((a) => a > 0.5)
        const unit = unitAllocs.length > 0 ? Math.min(...unitAllocs) : 0
        const alloc = Number(primary.allocationUsd ?? 0)
        if (unit > 0 && alloc >= unit * 1.5) {
          const factor = Math.round(alloc / unit)
          if (factor >= 2 && Math.abs(alloc - unit * factor) / Math.max(alloc, 1) < 0.1) {
            const ratio = unit / alloc
            const oldPnl = primary.pnl != null ? Number(primary.pnl) : null
            await prisma.trade.update({
              where: { id: primary.id },
              data: {
                allocationUsd: unit,
                ...(oldPnl != null && Number.isFinite(oldPnl)
                  ? { pnl: Math.round(oldPnl * ratio * 1e8) / 1e8 }
                  : {}),
              },
            })
            fixed++
            logger.info(
              { userId, pair: primary.pair, fromUsd: alloc, toUsd: unit, factor },
              '[jupiter] corrected inflated burst trade volume',
            )
          }
        }
      }
    }
    i = j > i + 1 ? j : i + 1
  }
  return fixed
}

/**
 * Drop ghost OPEN lots when the Solana wallet no longer holds the token
 * (Convert, external sell, or a sell that never updated the trade book).
 * Uses listSolanaHoldings (+ last-good cache) so RPC blips don't cancel real lots.
 */
export async function reconcileStaleJupiterOpenTrades(userId: string): Promise<number> {
  if (!isSolanaWalletEnabled() || !isJupiterConfigured()) return 0
  const burstFixed = await reconcileInflatedJupiterBurstTrades(userId).catch(() => 0)
  await mergeDuplicateJupiterOpenTrades(userId).catch(() => 0)
  const strategyId = await ensureJupiterStrategyId()
  const opens = await prisma.trade.findMany({
    where: { userId, strategyId, status: TradeStatus.OPEN },
    select: { id: true, pair: true, entryPrice: true, allocationUsd: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
  if (opens.length === 0) return 0

  let holdings: Awaited<ReturnType<typeof listSolanaHoldings>>
  try {
    holdings = await listSolanaHoldings(userId)
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), userId },
      '[jupiter] stale reconcile skipped (holdings fetch failed)',
    )
    return 0
  }

  const balByMint = new Map(holdings.map((h) => [h.mint, h.amount]))
  type BaseAgg = {
    tradeIds: string[]
    lotQty: number
    totalAlloc: number
    weightedEntrySum: number
    youngestAt: number
  }
  const byBase = new Map<string, BaseAgg>()
  const now = Date.now()
  for (const t of opens) {
    const base = String(t.pair ?? '').replace(/\/USDT$/i, '').toUpperCase()
    if (!base) continue
    const entry = Number(t.entryPrice)
    const alloc = Number(t.allocationUsd ?? 0)
    const qty = entry > 0 && alloc > 0 ? alloc / entry : 0
    const row = byBase.get(base) ?? {
      tradeIds: [],
      lotQty: 0,
      totalAlloc: 0,
      weightedEntrySum: 0,
      youngestAt: 0,
    }
    row.tradeIds.push(t.id)
    row.lotQty += qty
    if (alloc > 0 && entry > 0) {
      row.totalAlloc += alloc
      row.weightedEntrySum += entry * alloc
    }
    row.youngestAt = Math.max(row.youngestAt, t.createdAt.getTime())
    byBase.set(base, row)
  }

  const toCancel: string[] = []
  let downscaled = 0
  for (const [base, agg] of byBase) {
    if (agg.lotQty <= 1e-10) {
      toCancel.push(...agg.tradeIds)
      continue
    }
    // A fill can take a few minutes to show up on the public RPC — cancelling
    // immediately produced ghost CANCELLED rows (e.g. ZEC rebuy right after a
    // successful close) even though the swap had already landed on-chain.
    if (now - agg.youngestAt < RECONCILE_GRACE_MS) continue
    const token = await getJupiterTradableToken(`${base}USDT`)
    if (!token) continue
    let walletQty = balByMint.get(token.mint) ?? 0
    // One quick retry for lots that just aged out of the grace window.
    if (walletQty < agg.lotQty * 0.05 && now - agg.youngestAt < RECONCILE_GRACE_MS + 90_000) {
      await new Promise((r) => setTimeout(r, 2_000))
      try {
        walletQty = await getSolanaTokenBalance(userId, token.mint, token.decimals)
      } catch {
        /* keep first read */
      }
    }
    // Same threshold as BSC dexOpenPositionWatcher: <5% of booked lot → ghost.
    if (walletQty < agg.lotQty * 0.05) {
      toCancel.push(...agg.tradeIds)
      continue
    }

    // Duplicate-submit bugs can inflate allocationUsd (e.g. 3× $42 booked but
    // only one on-chain fill). Align the OPEN row to wallet qty so dashboard
    // cost basis and sell preview match what the user actually holds.
    const avgEntry =
      agg.totalAlloc > 0 && agg.weightedEntrySum > 0
        ? agg.weightedEntrySum / agg.totalAlloc
        : agg.lotQty > 0
          ? agg.totalAlloc / agg.lotQty
          : 0
    if (
      avgEntry > 0 &&
      walletQty > 0 &&
      walletQty < agg.lotQty * OVERBOOK_DOWNSCALE_RATIO &&
      agg.totalAlloc > 0.5
    ) {
      const newAlloc = Math.round(walletQty * avgEntry * 1e8) / 1e8
      if (newAlloc > 0.5 && newAlloc + 0.01 < agg.totalAlloc) {
        const primaryId = agg.tradeIds[0]!
        const extraIds = agg.tradeIds.slice(1)
        await prisma.trade.update({
          where: { id: primaryId },
          data: { allocationUsd: newAlloc },
        })
        if (extraIds.length > 0) {
          await prisma.trade.updateMany({
            where: { id: { in: extraIds }, status: TradeStatus.OPEN },
            data: { status: TradeStatus.CANCELLED },
          })
        }
        downscaled += 1
        logger.info(
          {
            userId,
            base,
            bookQty: agg.lotQty,
            walletQty,
            bookAllocUsd: agg.totalAlloc,
            walletAllocUsd: newAlloc,
          },
          '[jupiter] downscaled over-booked OPEN lot to wallet balance',
        )
      }
    }
  }

  if (toCancel.length > 0) {
    await prisma.trade.updateMany({
      where: { id: { in: toCancel }, status: TradeStatus.OPEN },
      data: { status: TradeStatus.CANCELLED },
    })
    logger.info(
      { userId, cancelled: toCancel.length, symbols: [...byBase.keys()].filter((b) =>
        toCancel.some((id) => byBase.get(b)?.tradeIds.includes(id)),
      ) },
      '[jupiter] cancelled stale OPEN (wallet empty for lot)',
    )
  }
  return burstFixed + toCancel.length + downscaled
}

/** Live "P&L vs break-even" for every open DEX Jupiter lot, judged on the Jupiter bid (not Binance). */
export async function getJupiterOpenPositions(
  userId: string,
  slippageBps = 100,
): Promise<JupiterOpenPosition[]> {
  if (!isJupiterConfigured()) return []
  await reconcileStaleJupiterOpenTrades(userId).catch(() => 0)
  const strategyId = await ensureJupiterStrategyId()
  const opens = await prisma.trade.findMany({
    where: { userId, strategyId, status: TradeStatus.OPEN },
    select: {
      pair: true,
      entryPrice: true,
      allocationUsd: true,
      pnl: true,
      takeProfitPct: true,
      stopLossPct: true,
      trailingStop: true,
    },
    orderBy: { createdAt: 'asc' },
  })
  if (opens.length === 0) return []

  const exitPrefs = getJupiterExitSettings(userId)

  const byBase = new Map<
    string,
    {
      totalAlloc: number
      weightedEntry: number
      bankedSkim: number
      overrides: { takeProfitPct: number | null; stopLossPct: number | null; trailingStop: boolean | null }
    }
  >()
  for (const t of opens) {
    const alloc = Number(t.allocationUsd ?? 0)
    const entry = Number(t.entryPrice)
    if (alloc <= 0 || entry <= 0) continue
    const base = String(t.pair ?? '').replace(/\/USDT$/i, '').toUpperCase()
    if (!base) continue
    const agg =
      byBase.get(base) ?? {
        totalAlloc: 0,
        weightedEntry: 0,
        bankedSkim: 0,
        overrides: { takeProfitPct: null, stopLossPct: null, trailingStop: null },
      }
    agg.totalAlloc += alloc
    agg.weightedEntry += entry * alloc
    const skim = Number(t.pnl ?? 0)
    if (Number.isFinite(skim) && skim > 0) agg.bankedSkim += skim
    // Oldest row is the surviving primary lot — its overrides represent the position.
    if (agg.overrides.takeProfitPct == null && t.takeProfitPct != null) {
      agg.overrides.takeProfitPct = Number(t.takeProfitPct)
    }
    if (agg.overrides.stopLossPct == null && t.stopLossPct != null) {
      agg.overrides.stopLossPct = Number(t.stopLossPct)
    }
    if (agg.overrides.trailingStop == null && t.trailingStop != null) {
      agg.overrides.trailingStop = t.trailingStop
    }
    byBase.set(base, agg)
  }

  const targetNet = env.dexMinNetProfitUsd + SOLANA_DEX_ROUND_TRIP_FEE_USD
  const slipFactor = 1 - Math.min(2000, Math.max(0, slippageBps)) / 10_000

  const positions = await Promise.all(
    [...byBase.entries()].map(async ([base, agg]): Promise<JupiterOpenPosition | null> => {
      if (agg.totalAlloc <= 0) return null
      const avgEntry = agg.weightedEntry / agg.totalAlloc
      const qty = avgEntry > 0 ? agg.totalAlloc / avgEntry : 0
      const token = await getJupiterTradableToken(`${base}USDT`)
      if (!token) return null

      const marks = await getJupiterExecutableMarks(base, { positionQty: qty })
      const liveSellPrice = marks?.bid ?? null
      const liveMidPrice = marks?.mid ?? null
      let estNetPnlUsd: number | null = null
      let breakEvenSellPrice: number | null = null
      let upsideToBreakEvenPct: number | null = null
      let priceVsEntryPct: number | null = null
      let currentValueUsd: number | null = null

      if (liveSellPrice && liveSellPrice > 0) {
        currentValueUsd = Math.round(qty * liveSellPrice * 1e4) / 1e4
        priceVsEntryPct = Math.round(((liveSellPrice - avgEntry) / avgEntry) * 1e4) / 100
        estNetPnlUsd = estimatedNetRoundTripUsd(
          agg.totalAlloc,
          avgEntry,
          liveSellPrice,
          slippageBps,
          SOLANA_DEX_ROUND_TRIP_FEE_USD,
        )
        if (slipFactor > 0) {
          const requiredGross = targetNet / slipFactor
          breakEvenSellPrice = avgEntry * (1 + requiredGross / agg.totalAlloc)
          upsideToBreakEvenPct =
            liveSellPrice >= breakEvenSellPrice
              ? 0
              : Math.round(((breakEvenSellPrice - liveSellPrice) / liveSellPrice) * 1e4) / 100
        }
      }

      const inProfit =
        liveSellPrice != null &&
        breakEvenSellPrice != null &&
        liveSellPrice >= breakEvenSellPrice &&
        estNetPnlUsd != null &&
        estNetPnlUsd >= env.dexMinNetProfitUsd

      return {
        baseSymbol: base,
        binanceSymbol: token.binanceSymbol,
        mint: token.mint,
        avgEntry: Math.round(avgEntry * 1e8) / 1e8,
        qty: Math.round(qty * 1e8) / 1e8,
        totalAllocUsd: Math.round(agg.totalAlloc * 1e2) / 1e2,
        liveSellPrice: liveSellPrice != null ? Math.round(liveSellPrice * 1e8) / 1e8 : null,
        liveMidPrice: liveMidPrice != null ? Math.round(liveMidPrice * 1e8) / 1e8 : null,
        currentValueUsd,
        estNetPnlUsd,
        breakEvenSellPrice: breakEvenSellPrice != null ? Math.round(breakEvenSellPrice * 1e8) / 1e8 : null,
        upsideToBreakEvenPct,
        priceVsEntryPct,
        inProfit,
        bankedSkimUsd: Math.round(agg.bankedSkim * 1e4) / 1e4,
        takeProfitPct: agg.overrides.takeProfitPct ?? exitPrefs.takeProfitPct,
        stopLossPct: agg.overrides.stopLossPct ?? exitPrefs.stopLossPct,
        trailingStop: agg.overrides.trailingStop ?? exitPrefs.trailingStop,
        exitOverrides: agg.overrides,
      }
    }),
  )

  return positions
    .filter((p): p is JupiterOpenPosition => p !== null)
    .sort((a, b) => (b.totalAllocUsd ?? 0) - (a.totalAllocUsd ?? 0))
}

async function fetchJupiterBuyPrice(
  token: ResolvedSolToken,
  usdcHuman: number,
  slippageBps: number,
): Promise<number | null> {
  if (usdcHuman <= 0) return null
  try {
    const order = await getJupiterOrder({
      inputMint: SOL_USDC_MINT,
      outputMint: token.mint,
      amount: toSmallest(usdcHuman, 6),
      slippageBps,
    })
    const out = fromSmallest(order.outAmount, token.decimals)
    return out > 0 ? usdcHuman / out : null
  } catch {
    return null
  }
}

async function fetchJupiterSellPrice(
  token: ResolvedSolToken,
  tokenQtyHuman: number,
  slippageBps: number,
): Promise<number | null> {
  if (tokenQtyHuman <= 0) return null
  try {
    const order = await getJupiterOrder({
      inputMint: token.mint,
      outputMint: SOL_USDC_MINT,
      amount: toSmallest(tokenQtyHuman, token.decimals),
      slippageBps,
    })
    const out = fromSmallest(order.outAmount, 6)
    return tokenQtyHuman > 0 ? out / tokenQtyHuman : null
  } catch {
    return null
  }
}


function toSmallest(amountHuman: number, decimals: number): string {
  const factor = 10 ** decimals
  const raw = Math.floor(amountHuman * factor)
  return String(Math.max(1, raw))
}

function fromSmallest(raw: string, decimals: number): number {
  return Number(raw) / 10 ** decimals
}

export type JupiterSwapRequest = {
  side: 'BUY' | 'SELL'
  binanceSymbol: string
  /** Spend amount (in `spendAsset` units) when BUY; token amount when SELL. */
  amount: number
  slippageBps?: number
  /** Legacy USDC/SOL spend selector (default USDC). Ignored on SELL. */
  spendAsset?: JupiterSpendAsset
  /** Any SPL mint the user holds to pay with on a BUY. Wins over spendAsset. */
  spendMint?: string
}

export type JupiterQuotePreview = {
  binanceSymbol: string
  side: 'BUY' | 'SELL'
  token: ResolvedSolToken
  amountIn: string
  amountOut: string
  amountInHuman: number
  amountOutHuman: number
  /** USD notional of the quoted leg (USDC in on buy; ~token×mid on sell). */
  notionalUsd: number | null
  binanceMidPrice: number | null
  executablePrice: number | null
  priceVsBinanceBps: number | null
  priceImpactPct: number | null
  latencyMs: number
  tradable: boolean
  blockTrade: boolean
  blockReason?: string
  router?: string
  message?: string
  /** Simultaneous Jupiter buy price at ~same notional (USDC per token). */
  jupiterBuyPrice?: number | null
  /** Simultaneous Jupiter sell price at ~same size (USDC per token). */
  jupiterSellPrice?: number | null
  /** sellPrice vs buyPrice spread in bps (negative = sell below buy). */
  roundTripSpreadBps?: number | null
  /** Immediate round-trip PnL in USDC if you buy then sell at quoted prices. */
  estRoundTripLossUsd?: number | null
  /** Weighted avg entry from open DEX Jupiter book lots. */
  openEntryPrice?: number | null
  /** Minimum sell price to beat entry (+ fees). */
  minProfitableSellPrice?: number | null
  /** Exact sell price that nets >= min profit after spread + Solana fees. */
  breakEvenSellPrice?: number | null
  /** % the live sell price must still rise to reach break-even (0 if already profitable). */
  upsideToBreakEvenPct?: number | null
  priceVsEntryBps?: number | null
  estNetPnlUsd?: number | null
  takeProfitPct?: number | null
  stopLossPct?: number | null
  /** How much price must rise after this buy to reach break-even sell (spread + fees). */
  minMoveToBreakEvenPct?: number | null
  /** Smart-entry quality: good = tight spread, caution = wide, poor = blocked. */
  entryQuality?: 'good' | 'caution' | 'poor'
  /** Human-readable smart-entry summary for the UI. */
  entryQualityNote?: string | null
  /** Binance book mid — CEX reference (not executable on Solana). */
  binanceRefMid?: number | null
  /** Positive when Jupiter ask is below Binance mid (favorable buy window). */
  cexEdgeBps?: number | null
}

export type JupiterPreviewOptions = {
  userId?: string
  /** Dashboard "sell open" bypasses entry guard — user explicitly exits. */
  skipEntryGuard?: boolean
}

export type JupiterExecuteOptions = {
  skipEntryGuard?: boolean
  /** Skip preview quote on dashboard sells — one fewer Jupiter /order call. */
  skipPreview?: boolean
  /** Profit-skim: sell partial qty, keep OPEN trade with reduced allocation. */
  partialSkim?: boolean
  /** Prefer best-scoring Jupiter venue filter (Metis fallback on failure). */
  smartRoute?: boolean
}

export async function previewJupiterSwap(
  req: JupiterSwapRequest,
  opts?: JupiterPreviewOptions,
): Promise<JupiterQuotePreview> {
  if (!isJupiterConfigured()) {
    throw new Error('Jupiter is not configured on this server (JUPITER_API_KEY).')
  }
  const tokenRaw = await getJupiterTradableToken(req.binanceSymbol)
  if (!tokenRaw) {
    return {
      binanceSymbol: req.binanceSymbol.toUpperCase(),
      side: req.side,
      token: {
        baseSymbol: req.binanceSymbol.replace(/USDT$/i, ''),
        binanceSymbol: req.binanceSymbol.toUpperCase(),
        mint: '',
        decimals: 9,
        name: req.binanceSymbol,
        source: 'catalog',
      },
      amountIn: '0',
      amountOut: '0',
      amountInHuman: 0,
      amountOutHuman: 0,
      notionalUsd: null,
      binanceMidPrice: null,
      executablePrice: null,
      priceVsBinanceBps: null,
      priceImpactPct: null,
      latencyMs: 0,
      tradable: false,
      blockTrade: true,
      message: `Token ${req.binanceSymbol} is listed but mint could not be resolved — wait for token list refresh or pick another pair.`,
    }
  }
  const token = await hydrateSolTokenDecimals(tokenRaw)

  let quoteAmount = req.amount
  // Mid reference only — passing buyUsd/positionQty here duplicates the main /order
  // quote on the same size and was a major source of Jupiter 429 rate limits.
  const marks = await getJupiterExecutableMarks(token.binanceSymbol, {
    cacheOnly: isJupiterSwapRateLimited(),
  })
  const jupiterMid = marks?.mid ?? null
  const binanceRefMid =
    req.side === 'BUY' && !token.native ? await fetchBinanceBookMid(token.binanceSymbol) : null
  if (req.side === 'SELL' && jupiterMid && jupiterMid > 0) {
    const notional = req.amount * jupiterMid
    if (notional > MAX_SELL_NOTIONAL_USD) {
      return {
        binanceSymbol: token.binanceSymbol,
        side: req.side,
        token,
        amountIn: '0',
        amountOut: '0',
        amountInHuman: req.amount,
        amountOutHuman: 0,
        notionalUsd: notional,
        binanceMidPrice: jupiterMid,
        executablePrice: null,
        priceVsBinanceBps: null,
        priceImpactPct: null,
        latencyMs: 0,
        tradable: false,
        blockTrade: true,
        blockReason: `Sell size ~$${notional.toLocaleString(undefined, { maximumFractionDigits: 0 })} is too large — enter token qty for ~$50–$${MAX_SELL_NOTIONAL_USD.toLocaleString()} notional, not "50 BTC".`,
        message: 'Sell amount notional too large for a safe quote.',
      }
    }
  }

  const slippageBps = Math.min(2000, Math.max(10, req.slippageBps ?? 100))
  // Resolve the pay-with token (any held SPL mint, or legacy USDC/SOL). Keep all
  // PnL/guard math in USD via its live unit price, even for volatile spend coins.
  const spend =
    req.side === 'BUY'
      ? await resolveSpendMint({ spendMint: req.spendMint, spendAsset: req.spendAsset })
      : { mint: SOL_USDC_MINT, decimals: 6, usdPerUnit: 1, isNativeSol: false }
  const spendUsdPerUnit = spend.usdPerUnit
  if (req.side === 'BUY' && spendUsdPerUnit <= 0) {
    return {
      binanceSymbol: token.binanceSymbol,
      side: req.side,
      token,
      amountIn: '0',
      amountOut: '0',
      amountInHuman: req.amount,
      amountOutHuman: 0,
      notionalUsd: null,
      binanceMidPrice: jupiterMid,
      executablePrice: null,
      priceVsBinanceBps: null,
      priceImpactPct: null,
      latencyMs: 0,
      tradable: false,
      blockTrade: true,
      message: 'Could not price your selected pay-with token right now — try again in a moment.',
    }
  }
  const inputMint = req.side === 'BUY' ? spend.mint : token.mint
  const outputMint = req.side === 'BUY' ? token.mint : SOL_USDC_MINT
  const inDecimals = req.side === 'BUY' ? spend.decimals : token.decimals
  const outDecimals = req.side === 'BUY' ? token.decimals : 6
  const amountIn = toSmallest(quoteAmount, inDecimals)

  let order
  try {
    order = await getJupiterOrder({
      inputMint,
      outputMint,
      amount: amountIn,
      slippageBps,
    })
  } catch (err) {
    return {
      binanceSymbol: token.binanceSymbol,
      side: req.side,
      token,
      amountIn,
      amountOut: '0',
      amountInHuman: req.amount,
      amountOutHuman: 0,
      notionalUsd: null,
      binanceMidPrice: jupiterMid,
      executablePrice: null,
      priceVsBinanceBps: null,
      priceImpactPct: null,
      latencyMs: 0,
      tradable: false,
      blockTrade: true,
      message: err instanceof Error ? err.message : 'Quote failed',
    }
  }

  const outHuman = fromSmallest(order.outAmount, outDecimals)
  const inHuman = fromSmallest(order.inAmount ?? amountIn, inDecimals)
  // For a BUY the input is the spend asset; convert it to USD so price/PnL math
  // is identical whether the user spends USDC or SOL.
  const inHumanUsd = req.side === 'BUY' ? inHuman * spendUsdPerUnit : inHuman
  let executablePrice: number | null = null
  let priceVsBinanceBps: number | null = null
  if (inHuman > 0 && outHuman > 0) {
    executablePrice = req.side === 'BUY' ? inHumanUsd / outHuman : outHuman / inHuman
    if (jupiterMid && jupiterMid > 0 && executablePrice > 0) {
      priceVsBinanceBps = Math.round(((executablePrice - jupiterMid) / jupiterMid) * 10_000)
    }
  }

  const priceImpactRaw = order.priceImpactPct != null ? parseFloat(String(order.priceImpactPct)) : NaN
  const priceImpactPct = Number.isFinite(priceImpactRaw) ? priceImpactRaw : null
  const notionalUsd =
    req.side === 'BUY'
      ? inHumanUsd
      : jupiterMid && jupiterMid > 0
        ? inHuman * jupiterMid
        : outHuman

  let blockTrade = false
  let blockReason: string | undefined
  if (req.side === 'BUY' && notionalUsd != null && notionalUsd > 0 && notionalUsd < MIN_BUY_NOTIONAL_USD) {
    blockTrade = true
    blockReason = `Minimum buy is ~$${MIN_BUY_NOTIONAL_USD} — increase the amount.`
  }
  if (
    req.side === 'BUY' &&
    priceVsBinanceBps != null &&
    priceVsBinanceBps > MAX_BUY_VS_JUPITER_MID_BPS
  ) {
    blockTrade = true
    blockReason = `Jupiter buy ask is ${(priceVsBinanceBps / 100).toFixed(2)}% above Jupiter mid — blocked to protect PnL. Wait for a tighter spread.`
  }
  if (
    req.side === 'SELL' &&
    priceVsBinanceBps != null &&
    priceVsBinanceBps < -MAX_SELL_VS_JUPITER_MID_BPS
  ) {
    blockTrade = true
    blockReason = `Jupiter sell bid is ${(Math.abs(priceVsBinanceBps) / 100).toFixed(2)}% below Jupiter mid — blocked. Reduce size or wait for a better route.`
  }

  let jupiterBuyPrice: number | null = null
  let jupiterSellPrice: number | null = null
  let roundTripSpreadBps: number | null = null
  let estRoundTripLossUsd: number | null = null
  let openEntryPrice: number | null = null
  let minProfitableSellPrice: number | null = null
  let breakEvenSellPrice: number | null = null
  let upsideToBreakEvenPct: number | null = null
  let priceVsEntryBps: number | null = null
  let estNetPnlUsd: number | null = null
  const exitPrefs = opts?.userId ? getJupiterExitSettings(opts.userId) : null
  const takeProfitPct = exitPrefs?.takeProfitPct ?? env.dexAutoTakeProfitPct
  const stopLossPct = exitPrefs?.stopLossPct ?? env.dexAutoStopLossPct
  let minMoveToBreakEvenPct: number | null = null
  let entryQuality: JupiterQuotePreview['entryQuality'] = 'good'
  let entryQualityNote: string | null = null
  let cexEdgeBps: number | null = null

  if (req.side === 'BUY' && inHuman > 0 && outHuman > 0 && executablePrice) {
    jupiterBuyPrice = executablePrice
    // Reuse cached per-symbol sell mark (shared with positions) instead of a 2nd /order call.
    jupiterSellPrice = await quoteJupiterSellUsdPerToken(token.baseSymbol, outHuman)
    if (jupiterBuyPrice > 0 && jupiterSellPrice != null) {
      roundTripSpreadBps = Math.round(((jupiterSellPrice - jupiterBuyPrice) / jupiterBuyPrice) * 10_000)
      estRoundTripLossUsd = Math.round((outHuman * jupiterSellPrice - inHumanUsd) * 1e4) / 1e4
    }
    // Smart entry: how far price must move up after this buy to break even on a sell.
    if (jupiterBuyPrice > 0 && inHumanUsd > 0) {
      const slipFactor = 1 - Math.min(2000, Math.max(0, slippageBps)) / 10_000
      const targetNet = env.dexMinNetProfitUsd + SOLANA_DEX_ROUND_TRIP_FEE_USD
      if (slipFactor > 0) {
        const requiredGross = targetNet / slipFactor
        const breakEvenAfterBuy = jupiterBuyPrice * (1 + requiredGross / inHumanUsd)
        minMoveToBreakEvenPct =
          Math.round(((breakEvenAfterBuy - jupiterBuyPrice) / jupiterBuyPrice) * 1e4) / 100
      }
    }
    const spreadBad =
      roundTripSpreadBps != null && roundTripSpreadBps <= -MAX_BUY_ROUND_TRIP_SPREAD_BPS
    const spreadCaution =
      roundTripSpreadBps != null &&
      roundTripSpreadBps <= -CAUTION_BUY_ROUND_TRIP_SPREAD_BPS &&
      !spreadBad
    const moveBad =
      minMoveToBreakEvenPct != null && minMoveToBreakEvenPct > MAX_MIN_MOVE_TO_BREAK_EVEN_PCT
    if (spreadBad || moveBad) {
      // Always block bad spreads — never relax the gate on 429. Trading into a
      // wide ask/bid is how Super Machine starts underwater before any move.
      entryQuality = 'poor'
      blockTrade = true
      const spreadTxt =
        roundTripSpreadBps != null
          ? `Round-trip spread ${(roundTripSpreadBps / 100).toFixed(2)}%`
          : 'Spread too wide'
      const moveTxt =
        minMoveToBreakEvenPct != null
          ? `needs +${minMoveToBreakEvenPct.toFixed(2)}% move to break even`
          : 'Break-even move too large'
      blockReason = isJupiterSwapRateLimited()
        ? `Smart entry blocked (rate-limited, last known quote bad) — ${spreadBad ? spreadTxt : moveTxt}.`
        : `Smart entry blocked — ${spreadBad ? spreadTxt : moveTxt}. Wait for tighter liquidity or pick a larger-cap token.`
      entryQualityNote = blockReason
    } else if (spreadCaution) {
      entryQuality = 'caution'
      entryQualityNote = `Wide spread (${((roundTripSpreadBps ?? 0) / 100).toFixed(2)}%). Price may need +${(minMoveToBreakEvenPct ?? 0).toFixed(2)}% to profit — proceed only if momentum is strong.`
    } else if (minMoveToBreakEvenPct != null) {
      entryQuality = 'good'
      entryQualityNote = `Tight entry — needs ~+${minMoveToBreakEvenPct.toFixed(2)}% to break even after fees.`
    }
    cexEdgeBps =
      binanceRefMid != null && binanceRefMid > 0
        ? Math.round(((binanceRefMid - executablePrice) / binanceRefMid) * 10_000)
        : null
    if (cexEdgeBps != null && cexEdgeBps >= 15 && entryQuality !== 'poor') {
      entryQuality = 'good'
      entryQualityNote = `CEX edge: ask ${(cexEdgeBps / 100).toFixed(2)}% below Binance mid — favorable entry vs spot. ${entryQualityNote ?? ''}`.trim()
    }
  } else if (req.side === 'SELL' && inHuman > 0 && executablePrice) {
    jupiterSellPrice = executablePrice
    const usdcRef = outHuman > 0 ? outHuman : jupiterMid && jupiterMid > 0 ? inHuman * jupiterMid : MIN_USDC_TRADE
    jupiterBuyPrice = await fetchJupiterBuyPrice(token, Math.max(MIN_USDC_TRADE, usdcRef), slippageBps)
    if (jupiterBuyPrice != null && jupiterBuyPrice > 0 && jupiterSellPrice > 0) {
      roundTripSpreadBps = Math.round(((jupiterSellPrice - jupiterBuyPrice) / jupiterBuyPrice) * 10_000)
      estRoundTripLossUsd = Math.round(inHuman * (jupiterSellPrice - jupiterBuyPrice) * 1e4) / 1e4
    }
  }

  if (req.side === 'SELL' && opts?.userId && executablePrice && !opts.skipEntryGuard) {
    const open = await getJupiterOpenEntry(opts.userId, token.baseSymbol)
    if (open) {
      openEntryPrice = open.avgEntry
      priceVsEntryBps = Math.round(((executablePrice - open.avgEntry) / open.avgEntry) * 10_000)
      const lotQty = open.totalAllocUsd / open.avgEntry
      const frac = lotQty > 0 ? Math.min(1, inHuman / lotQty) : 1
      const sliceAlloc = open.totalAllocUsd * frac
      estNetPnlUsd = estimatedNetRoundTripUsd(
        sliceAlloc,
        open.avgEntry,
        executablePrice,
        slippageBps,
        SOLANA_DEX_ROUND_TRIP_FEE_USD,
      )
      // Solve estimatedNetRoundTripUsd(...) = minNetProfit for the exit price.
      // gross = (minNet + fee) / (1 - slip);  exit = entry * (1 + gross/alloc)
      const slipFactor = 1 - Math.min(2000, Math.max(0, slippageBps)) / 10_000
      const targetNet = env.dexMinNetProfitUsd + SOLANA_DEX_ROUND_TRIP_FEE_USD
      if (sliceAlloc > 0 && slipFactor > 0) {
        const requiredGross = targetNet / slipFactor
        breakEvenSellPrice = open.avgEntry * (1 + requiredGross / sliceAlloc)
        minProfitableSellPrice = breakEvenSellPrice
        upsideToBreakEvenPct =
          executablePrice >= breakEvenSellPrice
            ? 0
            : Math.round(((breakEvenSellPrice - executablePrice) / executablePrice) * 10_000) / 100
      } else {
        minProfitableSellPrice = open.avgEntry
      }
      const pctVsEntry = priceVsEntryBps / 100
      const isStopLoss = pctVsEntry <= -stopLossPct
      const clearsBreakEven = breakEvenSellPrice != null && executablePrice >= breakEvenSellPrice
      const clearsFees = estNetPnlUsd >= env.dexMinNetProfitUsd
      if (!isStopLoss && (!clearsBreakEven || !clearsFees)) {
        blockTrade = true
        const target = breakEvenSellPrice ?? open.avgEntry
        blockReason = `Sell now nets $${estNetPnlUsd.toFixed(2)} after spread + fees. Break-even sell price is $${target.toFixed(target >= 1 ? 2 : 6)}/token (live ${executablePrice.toFixed(executablePrice >= 1 ? 2 : 6)}). Wait for +${(upsideToBreakEvenPct ?? 0).toFixed(2)}% or let auto take-profit fire at ${takeProfitPct}%. Use stop-loss at −${stopLossPct}% to exit a loss.`
      }
    }
  }

  return {
    binanceSymbol: token.binanceSymbol,
    side: req.side,
    token,
    amountIn: order.inAmount ?? amountIn,
    amountOut: order.outAmount,
    amountInHuman: inHuman,
    amountOutHuman: outHuman,
    notionalUsd,
    binanceMidPrice: jupiterMid,
    executablePrice,
    priceVsBinanceBps,
    priceImpactPct,
    latencyMs: order.latencyMs ?? 0,
    tradable: outHuman > 0 && !blockTrade,
    blockTrade,
    blockReason,
    router: order.router,
    jupiterBuyPrice,
    jupiterSellPrice,
    roundTripSpreadBps,
    estRoundTripLossUsd,
    openEntryPrice,
    minProfitableSellPrice,
    breakEvenSellPrice,
    upsideToBreakEvenPct,
    priceVsEntryBps,
    estNetPnlUsd,
    takeProfitPct,
    stopLossPct,
    minMoveToBreakEvenPct,
    entryQuality,
    entryQualityNote,
    binanceRefMid,
    cexEdgeBps,
  }
}

/** Suggested sell qty for ~$50 notional at live Jupiter mid (UI default). */
export function suggestJupiterSellQty(usdPerToken: number, tokenDecimals: number, usd = MIN_USDC_TRADE): number {
  return tokenQtyForUsdNotional(usd, usdPerToken, tokenDecimals)
}

export type JupiterSwapResult = {
  txSignature: string
  side: 'BUY' | 'SELL'
  binanceSymbol: string
  amountIn: string
  expectedOut: string
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

export async function executeJupiterSwap(
  userId: string,
  req: JupiterSwapRequest,
  execOpts?: JupiterExecuteOptions,
): Promise<JupiterSwapResult> {
  if (!isSolanaWalletEnabled()) {
    throw new Error('Solana wallet is not configured (WALLET_ENCRYPTION_KEY).')
  }
  if (!isJupiterConfigured()) {
    throw new Error('Jupiter is not configured (JUPITER_API_KEY).')
  }
  if (!Number.isFinite(req.amount) || req.amount <= 0) {
    throw new Error('amount must be positive')
  }

  await ensureSolanaPersonalWallet(userId)
  await ensureSolanaSwapGas(userId)

  // The preview enforces the minimum-notional floor + price/PnL guards (works
  // for any spend asset), so we no longer hard-code a 50 USDC minimum here.
  if (!execOpts?.skipPreview) {
    const fresh = await previewJupiterSwap(req, { userId, skipEntryGuard: execOpts?.skipEntryGuard })
    if (!fresh.tradable) {
      throw new Error(fresh.message ?? 'No executable Jupiter route for this pair.')
    }
    if (fresh.blockTrade) {
      throw new Error(fresh.blockReason ?? fresh.message ?? 'Trade blocked to protect PnL.')
    }
  }

  const tokenRaw = await getJupiterTradableToken(req.binanceSymbol)
  if (!tokenRaw) {
    throw new Error(`This pair is not available on Solana via Jupiter (${req.binanceSymbol}).`)
  }
  const token = await hydrateSolTokenDecimals(tokenRaw)

  const slippageBps = Math.min(2000, Math.max(10, req.slippageBps ?? 100))
  const spend =
    req.side === 'BUY'
      ? await resolveSpendMint({ spendMint: req.spendMint, spendAsset: req.spendAsset })
      : { mint: SOL_USDC_MINT, decimals: 6, usdPerUnit: 1, isNativeSol: false }
  const spendLabel =
    spend.mint === SOL_USDC_MINT ? 'USDC' : spend.isNativeSol ? 'SOL' : 'the selected token'
  const inputMint = req.side === 'BUY' ? spend.mint : token.mint
  const outputMint = req.side === 'BUY' ? token.mint : SOL_USDC_MINT
  const inDecimals = req.side === 'BUY' ? spend.decimals : token.decimals

  const kp = await getSolanaKeypair(userId)
  const taker = kp.publicKey.toBase58()

  let amountHuman = req.amount
  if (req.side === 'BUY') {
    const bal = await getSolanaTokenBalance(userId, spend.mint, spend.decimals)
    // Spending native SOL must leave a little behind for network/ATA fees.
    const needed = spend.isNativeSol ? amountHuman + SOL_GAS_RESERVE : amountHuman
    const dp = spend.isNativeSol ? 4 : spend.mint === SOL_USDC_MINT ? 2 : 6
    if (bal < needed) {
      throw new Error(
        `Insufficient ${spendLabel} — need ${needed.toFixed(dp)}, have ${bal.toFixed(dp)}` +
          (spend.isNativeSol ? ` (keeps ${SOL_GAS_RESERVE} SOL for fees)` : ''),
      )
    }
  } else {
    const bal = await getSolanaTokenBalance(userId, token.mint, token.decimals)
    if (bal <= 0) throw new Error(`Insufficient ${token.baseSymbol} balance`)
    amountHuman = Math.min(req.amount, bal)
  }

  const amountIn = toSmallest(amountHuman, inDecimals)

  // Execution engine: pick best Jupiter venue (Raydium/Orca/Meteora vs Metis).
  // Never blocks the trade — on failure we fall back to unrestricted Metis.
  let preferredDexes: string | undefined
  if (execOpts?.smartRoute !== false) {
    try {
      const pick = await Promise.race([
        pickBestJupiterDexFilter({
          side: req.side,
          binanceSymbol: req.binanceSymbol,
          amount: amountHuman,
          spendMint: req.side === 'BUY' ? spend.mint : undefined,
          slippageBps,
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_800)),
      ])
      if (pick?.dexes) {
        preferredDexes = pick.dexes
        logger.info(
          { userId, router: pick.router, dexes: preferredDexes },
          '[jupiter] smart route selected',
        )
      }
    } catch {
      /* Metis fallback */
    }
  }

  let order
  try {
    order = await getJupiterOrder({
      inputMint,
      outputMint,
      amount: amountIn,
      taker,
      slippageBps,
      ...(preferredDexes ? { dexes: preferredDexes } : {}),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Quote failed'
    // If a venue filter failed, retry unrestricted Metis; also recover from gas issues.
    if (preferredDexes || /failed to get quote/i.test(msg)) {
      if (/failed to get quote/i.test(msg)) await ensureSolanaSwapGas(userId)
      order = await getJupiterOrder({
        inputMint,
        outputMint,
        amount: amountIn,
        taker,
        slippageBps: Math.min(2000, Math.max(slippageBps, preferredDexes ? slippageBps : 300)),
      })
    } else {
      throw err
    }
  }
  if (!order.transaction) {
    throw new Error('Jupiter did not return a transaction — check wallet SOL for fees or try again.')
  }

  const txBuf = Buffer.from(order.transaction, 'base64')
  const vtx = VersionedTransaction.deserialize(txBuf)
  vtx.sign([kp])
  const signedB64 = Buffer.from(vtx.serialize()).toString('base64')

  const executed = await submitJupiterExecute({
    signedTransaction: signedB64,
    requestId: order.requestId,
  })
  const signature = executed.signature
  if (!signature) throw new Error('Jupiter execute did not return a signature')

  const outDecimals = req.side === 'BUY' ? token.decimals : 6
  const amountInNum = fromSmallest(order.inAmount ?? amountIn, inDecimals)
  const quotedOutNum = fromSmallest(order.outAmount, outDecimals)

  let allocationUsd = 0
  let entryPriceEff = 0
  if (req.side === 'BUY') {
    allocationUsd = amountInNum
    entryPriceEff = quotedOutNum > 1e-18 ? amountInNum / quotedOutNum : amountInNum
  } else {
    allocationUsd = quotedOutNum
    entryPriceEff = amountInNum > 1e-18 ? quotedOutNum / amountInNum : quotedOutNum
  }

  let safeEntry =
    Number.isFinite(entryPriceEff) && entryPriceEff > 0
      ? entryPriceEff
      : req.side === 'BUY'
        ? amountInNum / Math.max(quotedOutNum, 1e-18)
        : quotedOutNum / Math.max(amountInNum, 1e-18)
  safeEntry = await reconcileFillPriceWithMark(token.mint, safeEntry, req.side)
  const safeAlloc = Number.isFinite(allocationUsd) ? Math.round(allocationUsd * 1e8) / 1e8 : 0
  const pair = `${token.baseSymbol}/USDT`
  const strategyId = await ensureJupiterStrategyId()

  if (req.side === 'BUY') {
    const buyKey = `${userId}:${pair}`
    const inflight = jupiterBuyInFlight.get(buyKey)
    if (inflight != null && Date.now() - inflight < BUY_IN_FLIGHT_MS) {
      throw new Error('A buy for this token is already in progress — wait a few seconds and refresh.')
    }
    jupiterBuyInFlight.set(buyKey, Date.now())
  }

  logger.info(
    { userId, pair, side: req.side, signature, venue: 'jupiter' },
    '[jupiter] swap filled',
  )

  let recordedTrade: JupiterSwapResult['trade']

  try {
  if (req.side === 'BUY') {
    const existing = await prisma.trade.findFirst({
      where: { userId, strategyId, pair, status: TradeStatus.OPEN },
      orderBy: { createdAt: 'asc' },
    })
    if (existing) {
      const prevAlloc = Number(existing.allocationUsd ?? 0)
      const prevEntry = Number(existing.entryPrice)
      const newAlloc = (prevAlloc > 0 ? prevAlloc : 0) + safeAlloc
      const newEntry =
        prevAlloc > 0 && prevEntry > 0 && safeAlloc > 0
          ? (prevEntry * prevAlloc + safeEntry * safeAlloc) / newAlloc
          : safeEntry
      const updated = await prisma.trade.update({
        where: { id: existing.id },
        data: {
          allocationUsd: newAlloc,
          entryPrice: newEntry,
        },
      })
      await mergeDuplicateJupiterOpenTrades(userId).catch(() => 0)
      recordedTrade = {
        id: updated.id,
        pair,
        side: 'BUY',
        allocationUsd: newAlloc,
        entryPrice: newEntry,
        exitPrice: null,
        pnl: null,
        status: 'OPEN',
      }
    } else {
      const created = await prisma.trade.create({
        data: {
          userId,
          strategyId,
          pair,
          entryPrice: safeEntry,
          exitPrice: null,
          pnl: null,
          allocationUsd: safeAlloc > 0 ? safeAlloc : null,
          status: TradeStatus.OPEN,
        },
      })
      recordedTrade = {
        id: created.id,
        pair,
        side: 'BUY',
        allocationUsd: safeAlloc,
        entryPrice: safeEntry,
        exitPrice: null,
        pnl: null,
        status: 'OPEN',
      }
      void maybeCreditJupiterReferralVolume(userId, safeAlloc, 'BUY').catch((err) => {
        logger.warn({ err, userId }, '[jupiter-referral] volume credit failed')
      })
    }
  } else {
    const openPos = await prisma.trade.findFirst({
      where: { userId, pair, strategyId, status: TradeStatus.OPEN },
      orderBy: { createdAt: 'asc' },
    })
    if (openPos) {
      const buyAlloc = Number(openPos.allocationUsd ?? 0)
      const buyEntry = Number(openPos.entryPrice)
      const totalQty = buyEntry > 0 ? buyAlloc / buyEntry : 0
      const soldQty = amountHuman

      // Profit already banked on this lot from earlier skims — must survive
      // the final close (previously overwritten, so skimmed USDC "vanished"
      // from stats even though it was in the wallet).
      const priorSkimPnl = Number(openPos.pnl ?? 0)

      if (execOpts?.partialSkim && totalQty > 0 && soldQty < totalQty * 0.95) {
        const soldFraction = Math.min(0.95, soldQty / totalQty)
        const skimAlloc = buyAlloc * soldFraction
        const realized = roundTripRealizedPnl(skimAlloc, buyEntry, safeEntry)
        const remainingAlloc = Math.max(0, buyAlloc - skimAlloc)
        const updated = await prisma.trade.update({
          where: { id: openPos.id },
          data: {
            allocationUsd: remainingAlloc > 0.5 ? remainingAlloc : null,
            status: remainingAlloc > 0.5 ? TradeStatus.OPEN : TradeStatus.CLOSED,
            // Accumulate banked skim profit on the row while it stays OPEN so
            // the dashboard can show it and the final close doesn't lose it.
            pnl: priorSkimPnl + realized,
            ...(remainingAlloc <= 0.5 ? { exitPrice: safeEntry } : {}),
          },
        })
        recordedTrade = {
          id: updated.id,
          pair,
          side: remainingAlloc > 0.5 ? 'BUY' : 'CLOSED',
          allocationUsd: remainingAlloc > 0.5 ? remainingAlloc : buyAlloc,
          entryPrice: buyEntry,
          exitPrice: remainingAlloc > 0.5 ? null : safeEntry,
          pnl: realized,
          status: remainingAlloc > 0.5 ? 'OPEN' : 'CLOSED',
        }
      } else {
        const realized = roundTripRealizedPnl(buyAlloc, buyEntry, safeEntry)
        const totalPnl = priorSkimPnl + realized
        const updated = await prisma.trade.update({
          where: { id: openPos.id },
          data: { exitPrice: safeEntry, pnl: totalPnl, status: TradeStatus.CLOSED },
        })
        // Duplicate OPEN rows for the same pair share one wallet lot — when this
        // sell closes the primary row, drop the extras so they don't linger as
        // ghosts and show up as a misleading CANCELLED SELL in the trade log.
        await prisma.trade.updateMany({
          where: {
            userId,
            pair,
            strategyId,
            status: TradeStatus.OPEN,
            id: { not: openPos.id },
          },
          data: { status: TradeStatus.CANCELLED },
        })
        recordedTrade = {
          id: updated.id,
          pair,
          side: 'CLOSED',
          allocationUsd: buyAlloc,
          entryPrice: buyEntry,
          exitPrice: safeEntry,
          pnl: totalPnl,
          status: 'CLOSED',
        }
      }
    } else {
      const created = await prisma.trade.create({
        data: {
          userId,
          strategyId,
          pair,
          entryPrice: safeEntry,
          exitPrice: safeEntry,
          pnl: 0,
          allocationUsd: safeAlloc > 0 ? safeAlloc : null,
          status: TradeStatus.CLOSED,
        },
      })
      recordedTrade = {
        id: created.id,
        pair,
        side: 'SELL',
        allocationUsd: safeAlloc,
        entryPrice: safeEntry,
        exitPrice: safeEntry,
        pnl: 0,
        status: 'CLOSED',
      }
    }
  }
  } finally {
    if (req.side === 'BUY') {
      jupiterBuyInFlight.delete(`${userId}:${pair}`)
    }
  }

  return {
    txSignature: signature,
    side: req.side,
    binanceSymbol: token.binanceSymbol,
    amountIn: order.inAmount ?? amountIn,
    expectedOut: order.outAmount,
    trade: recordedTrade,
  }
}

// ---- Convert (Binance-style same-chain swap, any held coin → any coin) ------

export type SolanaConvertPreview = {
  fromMint: string
  toMint: string
  inAmount: number
  outAmount: number
  /** Units of `to` received per 1 unit of `from`. */
  rate: number
  /** Flat platform fee (USD) deducted from the input before the swap. */
  feeUsd?: number
}

export type SolanaConvertResult = {
  txSignature: string
  fromMint: string
  toMint: string
  inAmount: number
  outAmount: number
  /** Flat platform fee (USD) deducted from the input before the swap. */
  feeUsd?: number
}

function assertConvertInputs(req: { fromMint: string; toMint: string; amount: number }): void {
  if (!req.fromMint || !req.toMint) throw new Error('Pick both coins to convert.')
  if (req.fromMint === req.toMint) throw new Error('Choose two different coins.')
  if (!Number.isFinite(req.amount) || req.amount <= 0) throw new Error('Enter a valid amount.')
}

/**
 * Platform convert fee in source-token units ($0.10 worth). Fail-soft: an
 * unpriceable token skips the fee so the user's convert still works.
 */
async function solConvertFeeTokens(fromMint: string, amount: number): Promise<number> {
  let price: number | null = null
  if (fromMint === SOL_USDC_MINT) price = 1
  else {
    const prices = await fetchJupiterPricesV3([fromMint]).catch(() => new Map())
    price = prices.get(fromMint)?.usdPrice ?? null
  }
  if (!price || price <= 0) return 0
  const feeTokens = CONVERT_FEE_USD / price
  if (feeTokens >= amount * 0.2) {
    throw new Error(`Convert amount is too small — minimum is about $${(CONVERT_FEE_USD * 5).toFixed(2)}.`)
  }
  return feeTokens
}

/** Quote-only estimate for a same-chain convert (no signing, no balance check). */
export async function previewSolanaConvert(req: {
  fromMint: string
  toMint: string
  amount: number
  slippageBps?: number
}): Promise<SolanaConvertPreview> {
  if (!isJupiterConfigured()) throw new Error('Jupiter is not configured (JUPITER_API_KEY).')
  assertConvertInputs(req)

  const feeTokens = await solConvertFeeTokens(req.fromMint, req.amount)
  const netAmount = req.amount - feeTokens

  const fromDecimals = await getSolanaMintDecimals(req.fromMint)
  const toDecimals = await getSolanaMintDecimals(req.toMint)
  const amountIn = toSmallest(netAmount, fromDecimals)
  const order = await getJupiterOrder({
    inputMint: req.fromMint,
    outputMint: req.toMint,
    amount: amountIn,
    slippageBps: Math.min(2000, Math.max(10, req.slippageBps ?? 100)),
  })
  const inAmount = req.amount
  const outAmount = fromSmallest(order.outAmount, toDecimals)
  return {
    fromMint: req.fromMint,
    toMint: req.toMint,
    inAmount,
    outAmount,
    rate: inAmount > 0 ? outAmount / inAmount : 0,
    feeUsd: feeTokens > 0 ? CONVERT_FEE_USD : 0,
  }
}

/**
 * Execute a same-chain Solana convert (any held SPL/SOL → any coin) via Jupiter.
 * Unlike a BUY/SELL this opens no position and records no PnL — it's a wallet
 * rebalance, mirroring Binance Convert.
 */
export async function convertSolanaTokens(
  userId: string,
  req: { fromMint: string; toMint: string; amount: number; slippageBps?: number },
): Promise<SolanaConvertResult> {
  if (!isSolanaWalletEnabled()) throw new Error('Solana wallet is not configured (WALLET_ENCRYPTION_KEY).')
  if (!isJupiterConfigured()) throw new Error('Jupiter is not configured (JUPITER_API_KEY).')
  assertConvertInputs(req)

  await ensureSolanaPersonalWallet(userId)
  // Buying SOL for gas — skip top-up to avoid recursion; otherwise ensure gas first.
  if (req.toMint !== SOL_NATIVE_MINT || req.fromMint !== SOL_USDC_MINT) {
    await ensureSolanaSwapGas(userId)
  }

  const isNativeSolFrom = req.fromMint === SOL_NATIVE_MINT
  const fromDecimals = await getSolanaMintDecimals(req.fromMint)
  const bal = await getSolanaTokenBalance(userId, req.fromMint, fromDecimals)
  const needed = isNativeSolFrom ? req.amount + SOL_GAS_RESERVE : req.amount
  if (bal < needed) {
    throw new Error(
      `Insufficient balance — need ${needed.toFixed(isNativeSolFrom ? 4 : 6)}, have ${bal.toFixed(isNativeSolFrom ? 4 : 6)}` +
        (isNativeSolFrom ? ` (keeps ${SOL_GAS_RESERVE} SOL for fees)` : ''),
    )
  }

  // Platform fee ($0.10 in the source token) goes straight to the fee treasury.
  const feeTokens = await solConvertFeeTokens(req.fromMint, req.amount)
  let feePaid = false
  if (feeTokens > 0) {
    try {
      const feeSig = await sendSolanaTokenFromUser(userId, req.fromMint, feeTokens, feeTreasurySol())
      feePaid = true
      logger.info({ userId, fromMint: req.fromMint, feeTokens, feeSig }, '[jupiter] convert fee sent to treasury')
    } catch (err) {
      logger.warn({ userId, fromMint: req.fromMint, err }, '[jupiter] convert fee charge failed — skipping fee')
    }
  }
  const netAmount = feePaid ? req.amount - feeTokens : req.amount

  const kp = await getSolanaKeypair(userId)
  const taker = kp.publicKey.toBase58()
  const amountIn = toSmallest(netAmount, fromDecimals)
  const order = await getJupiterOrder({
    inputMint: req.fromMint,
    outputMint: req.toMint,
    amount: amountIn,
    taker,
    slippageBps: Math.min(2000, Math.max(10, req.slippageBps ?? 100)),
  })
  if (!order.transaction) {
    throw new Error('Jupiter did not return a transaction — keep a little SOL for fees or try again.')
  }

  const vtx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'))
  vtx.sign([kp])
  const signedB64 = Buffer.from(vtx.serialize()).toString('base64')
  const executed = await submitJupiterExecute({ signedTransaction: signedB64, requestId: order.requestId })
  const signature = executed.signature
  if (!signature) throw new Error('Jupiter execute did not return a signature')

  const toDecimals = await getSolanaMintDecimals(req.toMint)
  logger.info({ userId, fromMint: req.fromMint, toMint: req.toMint, signature, venue: 'jupiter' }, '[jupiter] convert filled')
  const { recordWalletConvert } = await import('../wallet/walletConvertHistoryService')
  const { getJupiterTradableRegistry } = await import('./jupiterTradableRegistry')
  const reg = await getJupiterTradableRegistry().catch(() => ({ tokens: [] as Array<{ mint: string; baseSymbol: string }> }))
  const sym = (mint: string) =>
    reg.tokens.find((t) => t.mint === mint)?.baseSymbol ??
    (mint === SOL_NATIVE_MINT ? 'SOL' : mint === SOL_USDC_MINT ? 'USDC' : mint.slice(0, 4))
  const swappedIn = fromSmallest(order.inAmount ?? amountIn, fromDecimals)
  await recordWalletConvert(userId, 'SOLANA', {
    fromSymbol: sym(req.fromMint),
    toSymbol: sym(req.toMint),
    inAmount: swappedIn,
    outAmount: fromSmallest(order.outAmount, toDecimals),
    txRef: signature,
  }).catch(() => undefined)
  return {
    txSignature: signature,
    fromMint: req.fromMint,
    toMint: req.toMint,
    inAmount: feePaid ? swappedIn + feeTokens : swappedIn,
    outAmount: fromSmallest(order.outAmount, toDecimals),
    feeUsd: feePaid ? CONVERT_FEE_USD : 0,
  }
}

export type JupiterSellOpenResult =
  | JupiterSwapResult
  | {
      clearedStale: true
      symbol: string
      cancelledCount: number
      message: string
    }

/** Dashboard "Sell now" for the DEX Jupiter SOL book. */
/**
 * Per-position exit overrides — lets the user retune take-profit / stop-loss /
 * trailing-stop on a RUNNING position. Null clears the override so the lot falls
 * back to the user's global exit settings.
 */
export async function setJupiterPositionExitOverrides(
  userId: string,
  symbol: string,
  overrides: { takeProfitPct?: number | null; stopLossPct?: number | null; trailingStop?: boolean | null },
): Promise<{ updated: number; pair: string }> {
  const sym = symbol.toUpperCase().replace(/USDT$/i, '')
  const pair = `${sym}/USDT`
  const strategyId = await ensureJupiterStrategyId()

  const data: { takeProfitPct?: number | null; stopLossPct?: number | null; trailingStop?: boolean | null } = {}
  if (overrides.takeProfitPct !== undefined) data.takeProfitPct = overrides.takeProfitPct
  if (overrides.stopLossPct !== undefined) data.stopLossPct = overrides.stopLossPct
  if (overrides.trailingStop !== undefined) data.trailingStop = overrides.trailingStop
  if (Object.keys(data).length === 0) return { updated: 0, pair }

  const res = await prisma.trade.updateMany({
    where: { userId, pair, strategyId, status: TradeStatus.OPEN },
    data,
  })
  logger.info({ userId, pair, overrides: data, updated: res.count }, '[jupiter] position exit overrides set')
  return { updated: res.count, pair }
}

/**
 * Manual profit skim — sells the profit slice of an open position into USDC and
 * keeps the rest running under its TP/SL. Mirrors the auto-skim math used by the
 * open-position watcher, but triggered by the user from the dashboard.
 */
export async function skimJupiterPositionProfit(
  userId: string,
  symbol: string,
): Promise<JupiterSwapResult> {
  const sym = symbol.toUpperCase().replace(/USDT$/i, '')
  const pair = `${sym}/USDT`
  const strategyId = await ensureJupiterStrategyId()

  await mergeDuplicateJupiterOpenTrades(userId).catch(() => 0)

  const openPos = await prisma.trade.findFirst({
    where: { userId, pair, strategyId, status: TradeStatus.OPEN },
    orderBy: { createdAt: 'asc' },
  })
  if (!openPos) throw new Error(`No open ${sym} position to skim`)

  const entry = Number(openPos.entryPrice)
  const buyAlloc = Number(openPos.allocationUsd ?? 0)
  if (!Number.isFinite(entry) || entry <= 0 || buyAlloc <= 0) {
    throw new Error(`Open ${sym} position has no recorded size`)
  }
  const lotQty = buyAlloc / entry

  const exitMark = await quoteJupiterSellUsdPerToken(sym, lotQty)
  if (exitMark == null || exitMark <= 0) {
    throw new Error('No executable Jupiter quote right now — try again in a few seconds')
  }

  const pct = ((exitMark - entry) / entry) * 100
  if (pct <= 0.05) {
    throw new Error(`${sym} is not in profit yet (${pct.toFixed(2)}% vs entry) — nothing to skim`)
  }

  const token = await getJupiterTradableToken(`${sym}USDT`)
  if (!token) throw new Error(`Unsupported symbol ${sym} on Jupiter Solana`)

  // Sell only the profit slice, capped at half the lot so the position keeps running.
  const profitUsd = buyAlloc * (pct / 100)
  const factor = 10 ** Math.min(token.decimals, 8)
  let skimQty = Math.min(lotQty * 0.5, profitUsd / exitMark)

  // Never skim more than the wallet actually holds (Convert / external transfers).
  const walletQty = await getSolanaTokenBalance(userId, token.mint, token.decimals)
  if (walletQty > 0) skimQty = Math.min(skimQty, walletQty * 0.98)
  skimQty = Math.floor(skimQty * factor) / factor

  if (skimQty <= 0 || skimQty >= lotQty * 0.9) {
    throw new Error('Profit slice is too small to skim on-chain — let it run a bit more')
  }

  // Net-of-fees guard: the skimmed slice must clear Solana round-trip costs.
  const skimSliceNet = estimatedNetRoundTripUsd(
    buyAlloc * (skimQty / lotQty),
    entry,
    exitMark,
    env.dexAutoExitSlippageBps,
    SOLANA_DEX_ROUND_TRIP_FEE_USD,
  )
  const minNetUsd = Math.min(env.dexMinNetProfitUsd, 0.02)
  if (skimSliceNet < minNetUsd) {
    throw new Error(
      `Skim would net ~$${skimSliceNet.toFixed(3)} after fees — below the $${minNetUsd.toFixed(2)} minimum`,
    )
  }

  const result = await executeJupiterSwap(
    userId,
    {
      side: 'SELL',
      binanceSymbol: `${sym}USDT`,
      amount: skimQty,
      slippageBps: env.dexAutoExitSlippageBps,
    },
    { skipEntryGuard: true, partialSkim: true },
  )

  logger.info(
    { userId, pair, skimQty, pct: pct.toFixed(2), signature: result.txSignature },
    '[jupiter] manual profit skim executed',
  )
  return result
}

export async function sellJupiterOpenPosition(
  userId: string,
  symbol: string,
  fraction: 'all' | 'half' = 'all',
): Promise<JupiterSellOpenResult> {
  const sym = symbol.toUpperCase().replace(/USDT$/i, '')
  const strategyId = await ensureJupiterStrategyId()
  const pair = `${sym}/USDT`
  const openTrades = await prisma.trade.findMany({
    where: { userId, pair, strategyId, status: TradeStatus.OPEN },
    orderBy: { createdAt: 'asc' },
  })
  if (openTrades.length === 0) {
    throw new Error(`No open ${sym} position in the DEX Jupiter trade book`)
  }

  await mergeDuplicateJupiterOpenTrades(userId).catch(() => 0)

  const token = await getJupiterTradableToken(`${sym}USDT`)
  if (!token) throw new Error(`Unsupported symbol ${sym} on Jupiter Solana`)

  const lotQty = openTrades.reduce((sum, t) => {
    const entry = Number(t.entryPrice)
    const alloc = Number(t.allocationUsd ?? 0)
    return entry > 0 && alloc > 0 ? sum + alloc / entry : sum
  }, 0)
  if (lotQty <= 0) {
    await prisma.trade.updateMany({
      where: { id: { in: openTrades.map((t) => t.id) }, status: TradeStatus.OPEN },
      data: { status: TradeStatus.CANCELLED },
    })
    return {
      clearedStale: true,
      symbol: sym,
      cancelledCount: openTrades.length,
      message: `Cleared ${openTrades.length} stale ${sym} open position(s) with no recorded quantity.`,
    }
  }

  const walletQty = await getSolanaTokenBalance(userId, token.mint, token.decimals)
  let sellQty = walletQty > 0 ? Math.min(lotQty, walletQty * 0.98) : 0
  if (fraction === 'half') sellQty = sellQty / 2
  const factor = 10 ** Math.min(token.decimals, 8)
  sellQty = Math.floor(sellQty * factor) / factor
  if (sellQty <= 0) {
    // Tokens already gone (closed elsewhere / Convert) — drop ghost OPEN rows.
    await prisma.trade.updateMany({
      where: { id: { in: openTrades.map((t) => t.id) }, status: TradeStatus.OPEN },
      data: { status: TradeStatus.CANCELLED },
    })
    logger.info(
      { userId, symbol: sym, cancelled: openTrades.length, walletQty, lotQty },
      '[jupiter] sell-open cleared stale OPEN (no wallet balance)',
    )
    return {
      clearedStale: true,
      symbol: sym,
      cancelledCount: openTrades.length,
      message: `No ${sym} balance in the Solana wallet — cleared ${openTrades.length} stale open position(s) from the trade book.`,
    }
  }

  const result = await executeJupiterSwap(
    userId,
    {
      side: 'SELL',
      binanceSymbol: token.binanceSymbol,
      amount: sellQty,
      slippageBps: env.dexAutoExitSlippageBps,
    },
    { skipEntryGuard: true, skipPreview: true, smartRoute: false },
  )

  // Re-fetch after merge — primary row may be the only OPEN left.
  const stillOpen = await prisma.trade.findMany({
    where: { userId, pair, strategyId, status: TradeStatus.OPEN },
    orderBy: { createdAt: 'asc' },
  })
  for (const t of stillOpen.slice(1)) {
    await prisma.trade.update({
      where: { id: t.id },
      data: { status: TradeStatus.CANCELLED },
    })
  }

  return result
}
