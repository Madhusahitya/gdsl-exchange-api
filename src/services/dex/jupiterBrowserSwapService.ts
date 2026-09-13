/**
 * Jupiter swaps signed by the user's own browser wallet.
 *
 * The server still builds the route and relays the execute call (it holds the
 * Jupiter API key), but it never sees a private key: the unsigned transaction
 * goes to the browser, Phantom/Solflare signs it, and the signed bytes come
 * back for submission.
 *
 * These fills are booked under a separate strategy from the platform wallet.
 * That isolation matters — the auto-exit watchers and the stale-position
 * reconciler check the platform wallet's balance, so a self-custody lot filed
 * alongside them would be auto-cancelled as a ghost or, worse, be expected to
 * auto-sell from a wallet the bot cannot sign for.
 */
import { VersionedTransaction } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'
import { prisma, TradeStatus } from '@cryptoflow/db'
import { logger } from '../../lib/logger'
import { SOL_USDC_MINT, SOL_NATIVE_MINT } from '../../lib/solDexCatalog'
import { listSolanaHoldingsForOwner } from '../wallet/solanaPersonalWalletService'
import { getJupiterTradableToken } from './jupiterTradableRegistry'
import { getJupiterOrder, isJupiterConfigured, submitJupiterExecute } from './jupiterClassicService'
import { fetchJupiterPricesV3 } from './jupiterPriceService'
import { getJupiterExitSettings } from './jupiterExitSettingsService'
import { roundTripRealizedPnl } from '../../lib/roundTripPnl'

export const JUPITER_SELF_CUSTODY_STRATEGY_NAME = 'DEX Jupiter SOL (self-custody)'

/** Minimum notional for a self-custody entry — below this Jupiter dust routes fail. */
const MIN_TRADE_USD = 1
/** SOL left untouched for network and ATA rent when spending native SOL. */
const SOL_GAS_RESERVE = 0.003
/** Jupiter request ids are short-lived; drop stale builds rather than replaying them. */
const BUILD_TTL_MS = 90_000

export type BrowserSwapSide = 'BUY' | 'SELL'

export type BrowserSwapBuild = {
  requestId: string
  /** Base64 unsigned VersionedTransaction for the wallet to sign. */
  transaction: string
  side: BrowserSwapSide
  binanceSymbol: string
  pair: string
  owner: string
  inputMint: string
  outputMint: string
  amountInHuman: number
  expectedOutHuman: number
  usdValue: number
  priceImpactPct: number | null
  slippageBps: number
  expiresAt: string
}

type BuildContext = {
  at: number
  userId: string
  owner: string
  side: BrowserSwapSide
  binanceSymbol: string
  pair: string
  baseSymbol: string
  amountInHuman: number
  expectedOutHuman: number
  usdValue: number
}

/**
 * Server-side memory of what each build actually was, so the recorded trade
 * comes from our own quote rather than whatever the client claims after signing.
 */
const builds = new Map<string, BuildContext>()

function pruneBuilds(): void {
  const cutoff = Date.now() - BUILD_TTL_MS
  for (const [id, ctx] of builds) {
    if (ctx.at < cutoff) builds.delete(id)
  }
}

function toSmallest(amount: number, decimals: number): string {
  return BigInt(Math.round(amount * 10 ** decimals)).toString()
}

function fromSmallest(raw: string | undefined, decimals: number): number {
  if (!raw) return 0
  return Number(raw) / 10 ** decimals
}

function parseOwner(raw: string): PublicKey {
  try {
    return new PublicKey((raw ?? '').trim())
  } catch {
    throw new Error('Invalid Solana wallet address')
  }
}

async function ensureSelfCustodyStrategyId(): Promise<string> {
  const strategy = await prisma.strategy.upsert({
    where: { name: JUPITER_SELF_CUSTODY_STRATEGY_NAME },
    update: {},
    create: {
      name: JUPITER_SELF_CUSTODY_STRATEGY_NAME,
      description:
        'Jupiter swaps signed by the user\u2019s own browser wallet. Not auto-managed — the bot holds no key for these positions.',
      riskLevel: 'MEDIUM',
    },
    select: { id: true },
  })
  return strategy.id
}

async function ownerBalance(owner: PublicKey, mint: string): Promise<{ amount: number; decimals: number }> {
  const holdings = await listSolanaHoldingsForOwner(owner)
  const hit = holdings.find((h) => h.mint === mint)
  return { amount: hit?.amount ?? 0, decimals: hit?.decimals ?? 0 }
}

async function usdPerUnit(mint: string): Promise<number> {
  if (mint === SOL_USDC_MINT) return 1
  const prices = await fetchJupiterPricesV3([mint]).catch(() => new Map())
  return prices.get(mint)?.usdPrice ?? 0
}

/**
 * Build (but do not sign) a Jupiter swap for a connected browser wallet.
 * Validates the wallet can actually cover the order before asking it to sign.
 */
export async function buildBrowserJupiterSwap(opts: {
  userId: string
  owner: string
  side: BrowserSwapSide
  binanceSymbol: string
  amount: number
  slippageBps?: number
  /** BUY only: which token in the connected wallet to spend. Defaults to USDC. */
  spendMint?: string
}): Promise<BrowserSwapBuild> {
  if (!isJupiterConfigured()) throw new Error('Jupiter is not configured (JUPITER_API_KEY).')
  if (!Number.isFinite(opts.amount) || opts.amount <= 0) throw new Error('amount must be positive')

  const owner = parseOwner(opts.owner)
  const token = await getJupiterTradableToken(opts.binanceSymbol)
  if (!token) {
    throw new Error(`This pair is not available on Solana via Jupiter (${opts.binanceSymbol}).`)
  }

  const slippageBps = Math.min(2000, Math.max(10, opts.slippageBps ?? 100))
  const spendMint = opts.side === 'BUY' ? (opts.spendMint?.trim() || SOL_USDC_MINT) : token.mint
  const inputMint = spendMint
  const outputMint = opts.side === 'BUY' ? token.mint : SOL_USDC_MINT

  const held = await ownerBalance(owner, inputMint)
  const inDecimals =
    held.decimals > 0
      ? held.decimals
      : inputMint === SOL_USDC_MINT
        ? 6
        : inputMint === SOL_NATIVE_MINT
          ? 9
          : token.decimals

  const isNativeSol = inputMint === SOL_NATIVE_MINT
  const needed = isNativeSol ? opts.amount + SOL_GAS_RESERVE : opts.amount
  if (held.amount < needed) {
    const dp = isNativeSol ? 4 : inputMint === SOL_USDC_MINT ? 2 : 6
    throw new Error(
      `Your connected wallet holds ${held.amount.toFixed(dp)} but needs ${needed.toFixed(dp)}` +
        (isNativeSol ? ` (keeps ${SOL_GAS_RESERVE} SOL for network fees)` : ''),
    )
  }

  // Every self-custody swap pays network + ATA fees from the connected wallet.
  const solHeld = isNativeSol ? held.amount : (await ownerBalance(owner, SOL_NATIVE_MINT)).amount
  if (solHeld < SOL_GAS_RESERVE) {
    throw new Error(
      `Your wallet needs about ${SOL_GAS_RESERVE} SOL for network fees (currently ${solHeld.toFixed(4)} SOL).`,
    )
  }

  const inUsd = await usdPerUnit(inputMint)
  const usdValue = inUsd > 0 ? opts.amount * inUsd : 0
  if (usdValue > 0 && usdValue < MIN_TRADE_USD) {
    throw new Error(`Order is about $${usdValue.toFixed(2)} — the minimum is $${MIN_TRADE_USD}.`)
  }

  const order = await getJupiterOrder({
    inputMint,
    outputMint,
    amount: toSmallest(opts.amount, inDecimals),
    taker: owner.toBase58(),
    slippageBps,
  })
  if (!order.transaction) {
    throw new Error('Jupiter did not return a transaction — try again, or add a little SOL for fees.')
  }

  const outDecimals = opts.side === 'BUY' ? token.decimals : 6
  const amountInHuman = fromSmallest(order.inAmount, inDecimals) || opts.amount
  const expectedOutHuman = fromSmallest(order.outAmount, outDecimals)
  const pair = `${token.baseSymbol}/USDT`

  pruneBuilds()
  builds.set(order.requestId, {
    at: Date.now(),
    userId: opts.userId,
    owner: owner.toBase58(),
    side: opts.side,
    binanceSymbol: opts.binanceSymbol.toUpperCase(),
    pair,
    baseSymbol: token.baseSymbol,
    amountInHuman,
    expectedOutHuman,
    usdValue: opts.side === 'BUY' ? (usdValue || amountInHuman) : expectedOutHuman,
  })

  return {
    requestId: order.requestId,
    transaction: order.transaction,
    side: opts.side,
    binanceSymbol: opts.binanceSymbol.toUpperCase(),
    pair,
    owner: owner.toBase58(),
    inputMint,
    outputMint,
    amountInHuman,
    expectedOutHuman,
    usdValue: opts.side === 'BUY' ? (usdValue || amountInHuman) : expectedOutHuman,
    priceImpactPct:
      order.priceImpactPct != null && Number.isFinite(Number(order.priceImpactPct))
        ? Number(order.priceImpactPct)
        : null,
    slippageBps,
    expiresAt: new Date(Date.now() + BUILD_TTL_MS).toISOString(),
  }
}

export type BrowserSwapResult = {
  txSignature: string
  side: BrowserSwapSide
  pair: string
  amountIn: number
  amountOut: number
  trade: {
    id: string
    pair: string
    status: 'OPEN' | 'CLOSED'
    entryPrice: number
    exitPrice: number | null
    pnl: number | null
    allocationUsd: number
  }
  /** Self-custody positions are never auto-exited; the UI must say so. */
  autoManaged: false
}

/**
 * Relay a wallet-signed transaction to Jupiter and book the fill.
 *
 * The trade is reconstructed from the stored build context, so a client cannot
 * report a different size or symbol than the one it was quoted.
 */
export async function submitBrowserJupiterSwap(opts: {
  userId: string
  requestId: string
  signedTransaction: string
}): Promise<BrowserSwapResult> {
  pruneBuilds()
  const ctx = builds.get(opts.requestId)
  if (!ctx) {
    throw new Error('This quote expired before it was signed. Get a fresh quote and try again.')
  }
  if (ctx.userId !== opts.userId) {
    throw new Error('Quote does not belong to this account')
  }

  // Confirm the signed bytes are the transaction we handed out, not a substitute.
  try {
    VersionedTransaction.deserialize(Buffer.from(opts.signedTransaction, 'base64'))
  } catch {
    throw new Error('Signed transaction could not be decoded')
  }

  const executed = await submitJupiterExecute({
    signedTransaction: opts.signedTransaction,
    requestId: opts.requestId,
  })
  const signature = executed.signature
  if (!signature) throw new Error('Jupiter execute did not return a signature')

  builds.delete(opts.requestId)

  const strategyId = await ensureSelfCustodyStrategyId()
  const allocationUsd = Math.round(Math.max(0, ctx.usdValue) * 1e8) / 1e8
  const effectivePrice =
    ctx.side === 'BUY'
      ? ctx.expectedOutHuman > 1e-18
        ? ctx.amountInHuman / ctx.expectedOutHuman
        : 0
      : ctx.amountInHuman > 1e-18
        ? ctx.expectedOutHuman / ctx.amountInHuman
        : 0

  logger.info(
    { userId: ctx.userId, owner: ctx.owner, pair: ctx.pair, side: ctx.side, signature },
    '[jupiter-browser] self-custody swap filled',
  )

  let trade: BrowserSwapResult['trade']

  if (ctx.side === 'BUY') {
    const created = await prisma.trade.create({
      data: {
        userId: ctx.userId,
        strategyId,
        pair: ctx.pair,
        entryPrice: effectivePrice,
        allocationUsd: allocationUsd > 0 ? allocationUsd : null,
        status: TradeStatus.OPEN,
      },
    })
    trade = {
      id: created.id,
      pair: ctx.pair,
      status: 'OPEN',
      entryPrice: effectivePrice,
      exitPrice: null,
      pnl: null,
      allocationUsd,
    }
  } else {
    const open = await prisma.trade.findFirst({
      where: { userId: ctx.userId, strategyId, pair: ctx.pair, status: TradeStatus.OPEN },
      orderBy: { createdAt: 'asc' },
    })
    if (open) {
      const buyAlloc = Number(open.allocationUsd ?? 0)
      const buyEntry = Number(open.entryPrice)
      const bookedQty = buyEntry > 0 ? buyAlloc / buyEntry : 0
      const soldQty = ctx.amountInHuman
      const priorPnl = Number(open.pnl ?? 0)

      // Selling only part of the lot leaves the rest open, with the banked
      // profit carried on the row so a later close doesn't lose it.
      const isPartial = bookedQty > 0 && soldQty < bookedQty * 0.95
      const soldFraction = isPartial ? Math.min(0.95, soldQty / bookedQty) : 1
      const closedAlloc = buyAlloc * soldFraction
      const remainingAlloc = Math.max(0, buyAlloc - closedAlloc)
      const realized = roundTripRealizedPnl(closedAlloc, buyEntry, effectivePrice)
      const stillOpen = isPartial && remainingAlloc > 0.5

      const updated = await prisma.trade.update({
        where: { id: open.id },
        data: {
          allocationUsd: stillOpen ? remainingAlloc : buyAlloc,
          pnl: priorPnl + realized,
          status: stillOpen ? TradeStatus.OPEN : TradeStatus.CLOSED,
          ...(stillOpen ? {} : { exitPrice: effectivePrice }),
        },
      })
      trade = {
        id: updated.id,
        pair: ctx.pair,
        status: stillOpen ? 'OPEN' : 'CLOSED',
        entryPrice: buyEntry,
        exitPrice: stillOpen ? null : effectivePrice,
        pnl: priorPnl + realized,
        allocationUsd: stillOpen ? remainingAlloc : buyAlloc,
      }
    } else {
      // Selling a coin that was never bought here (deposited, or bought elsewhere).
      const created = await prisma.trade.create({
        data: {
          userId: ctx.userId,
          strategyId,
          pair: ctx.pair,
          entryPrice: effectivePrice,
          exitPrice: effectivePrice,
          pnl: 0,
          allocationUsd: allocationUsd > 0 ? allocationUsd : null,
          status: TradeStatus.CLOSED,
        },
      })
      trade = {
        id: created.id,
        pair: ctx.pair,
        status: 'CLOSED',
        entryPrice: effectivePrice,
        exitPrice: effectivePrice,
        pnl: 0,
        allocationUsd,
      }
    }
  }

  return {
    txSignature: signature,
    side: ctx.side,
    pair: ctx.pair,
    amountIn: ctx.amountInHuman,
    amountOut: ctx.expectedOutHuman,
    trade,
    autoManaged: false,
  }
}

export type SelfCustodyPosition = {
  id: string
  pair: string
  baseSymbol: string
  binanceSymbol: string
  mint: string | null
  entryPrice: number
  markPrice: number | null
  allocationUsd: number
  qty: number
  pnlUsd: number | null
  pnlPct: number | null
  /** Live balance in the connected wallet, when an owner address was supplied. */
  walletQty: number | null
  /** Which exit threshold the position has crossed, if any. */
  alert: 'take_profit' | 'stop_loss' | null
  openedAt: string
}

/**
 * Open self-custody lots with live PnL and exit alerts.
 *
 * These positions are deliberately not auto-exited, so the thresholds the user
 * configured for the platform wallet are reported here as alerts instead — same
 * numbers, but the user pulls the trigger.
 */
export async function listSelfCustodyPositions(
  userId: string,
  owner?: string,
): Promise<{
  positions: SelfCustodyPosition[]
  thresholds: { takeProfitPct: number; stopLossPct: number }
}> {
  const strategyId = await ensureSelfCustodyStrategyId()
  const rows = await prisma.trade.findMany({
    where: { userId, strategyId, status: TradeStatus.OPEN },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  const exits = await getJupiterExitSettings(userId)

  const thresholds = {
    takeProfitPct: Number(exits.takeProfitPct ?? 10),
    stopLossPct: Number(exits.stopLossPct ?? 5),
  }
  if (rows.length === 0) return { positions: [], thresholds }

  const tokens = await Promise.all(
    rows.map((r) => getJupiterTradableToken(`${r.pair.replace(/\/USDT$/, '')}USDT`).catch(() => null)),
  )
  const mints = tokens.filter((t): t is NonNullable<typeof t> => t != null).map((t) => t.mint)
  const prices = mints.length > 0 ? await fetchJupiterPricesV3(mints).catch(() => new Map()) : new Map()

  let walletAmounts: Map<string, number> | null = null
  if (owner?.trim()) {
    try {
      const holdings = await listSolanaHoldingsForOwner(parseOwner(owner))
      walletAmounts = new Map(holdings.map((h) => [h.mint, h.amount]))
    } catch {
      walletAmounts = null
    }
  }

  const positions = rows.map((r, i) => {
    const baseSymbol = r.pair.replace(/\/USDT$/, '')
    const token = tokens[i]
    const entryPrice = Number(r.entryPrice)
    const allocationUsd = Number(r.allocationUsd ?? 0)
    const qty = entryPrice > 0 ? allocationUsd / entryPrice : 0
    const markPrice = token ? (prices.get(token.mint)?.usdPrice ?? null) : null

    const pnlPct =
      markPrice != null && entryPrice > 0 ? ((markPrice - entryPrice) / entryPrice) * 100 : null
    const pnlUsd = pnlPct != null ? (allocationUsd * pnlPct) / 100 : null

    let alert: SelfCustodyPosition['alert'] = null
    if (pnlPct != null) {
      if (pnlPct >= thresholds.takeProfitPct) alert = 'take_profit'
      else if (pnlPct <= -thresholds.stopLossPct) alert = 'stop_loss'
    }

    return {
      id: r.id,
      pair: r.pair,
      baseSymbol,
      binanceSymbol: `${baseSymbol}USDT`,
      mint: token?.mint ?? null,
      entryPrice,
      markPrice,
      allocationUsd,
      qty,
      pnlUsd,
      pnlPct,
      walletQty: token && walletAmounts ? (walletAmounts.get(token.mint) ?? 0) : null,
      alert,
      openedAt: r.createdAt.toISOString(),
    }
  })

  return { positions, thresholds }
}
