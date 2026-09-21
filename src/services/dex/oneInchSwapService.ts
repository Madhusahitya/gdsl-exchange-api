/**
 * Execute 1inch Classic swaps via the user's personal wallet (server-signed).
 * Isolated from PancakeSwap personalWalletService — separate strategy book.
 */
import {
  Contract,
  formatUnits,
  parseUnits,
  type TransactionResponse,
} from 'ethers'
import { erc20Abi } from '@cryptoflow/dex-pancake'
import { prisma, TradeStatus } from '@cryptoflow/db'
import { logger } from '../../lib/logger'
import { roundTripRealizedPnl } from '../../lib/roundTripPnl'
import { getBscProvider } from '../../lib/bscProvider'
import {
  getPersonalSigner,
  isPersonalWalletEnabled,
} from '../wallet/personalWalletService'
import { resolveBscTokenForBinanceSymbol, type ResolvedBscToken } from './bscTokenResolver'
import {
  buildOneInchApproveTx,
  buildOneInchSwap,
  getOneInchQuote,
  getOneInchSpender,
  isOneInchConfigured,
  ONEINCH_NATIVE,
  ONEINCH_USDT,
} from './oneInchClassicService'

const MIN_USDT_TRADE = 50
/** Reject buys when 1inch executable price is worse than Binance mid by more than this (bps). */
const MAX_BUY_VS_BINANCE_BPS = 90

async function ensureOneInchStrategyId(): Promise<string> {
  const strategy = await prisma.strategy.upsert({
    where: { name: 'DEX 1inch BSC' },
    update: {},
    create: {
      name: 'DEX 1inch BSC',
      description: 'Manual swaps routed via 1inch Classic aggregator on BNB Smart Chain.',
      riskLevel: 'MEDIUM',
    },
    select: { id: true },
  })
  return strategy.id
}

async function fetchBinanceMid(binanceSymbol: string): Promise<number | null> {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${binanceSymbol}`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!r.ok) return null
    const j = (await r.json()) as { price?: string }
    const p = parseFloat(j.price ?? 'NaN')
    return Number.isFinite(p) && p > 0 ? p : null
  } catch {
    return null
  }
}

async function ensureAllowance(
  signer: Awaited<ReturnType<typeof getPersonalSigner>>,
  tokenAddress: string,
  amount: bigint,
): Promise<void> {
  if (tokenAddress.toLowerCase() === ONEINCH_NATIVE) return
  const spender = await getOneInchSpender()
  const erc20 = new Contract(tokenAddress, erc20Abi, signer)
  const allowance = (await erc20.allowance(signer.address, spender)) as bigint
  if (allowance >= amount) return
  const approve = await buildOneInchApproveTx({
    tokenAddress,
    amount: amount.toString(),
  })
  const tx = await signer.sendTransaction({
    to: approve.to,
    data: approve.data,
    value: BigInt(approve.value || '0'),
  })
  await tx.wait(1)
}

export type OneInchSwapRequest = {
  side: 'BUY' | 'SELL'
  binanceSymbol: string
  /** USDT notional when BUY; token amount when SELL. */
  amount: number
  slippageBps?: number
}

export type OneInchQuotePreview = {
  binanceSymbol: string
  side: 'BUY' | 'SELL'
  token: ResolvedBscToken
  amountIn: string
  amountOut: string
  amountInHuman: number
  amountOutHuman: number
  binanceMidPrice: number | null
  executablePrice: number | null
  priceVsBinanceBps: number | null
  latencyMs: number
  tradable: boolean
  message?: string
}

export async function previewOneInchSwap(req: OneInchSwapRequest): Promise<OneInchQuotePreview> {
  if (!isOneInchConfigured()) {
    throw new Error('1inch is not configured on this server (ONEINCH_API_KEY).')
  }
  const token = await resolveBscTokenForBinanceSymbol(req.binanceSymbol)
  if (!token) {
    return {
      binanceSymbol: req.binanceSymbol.toUpperCase(),
      side: req.side,
      token: {
        baseSymbol: req.binanceSymbol.replace(/USDT$/i, ''),
        binanceSymbol: req.binanceSymbol.toUpperCase(),
        contractAddress: '0x0000000000000000000000000000000000000000',
        decimals: 18,
        name: req.binanceSymbol,
        source: 'catalog',
      },
      amountIn: '0',
      amountOut: '0',
      amountInHuman: 0,
      amountOutHuman: 0,
      binanceMidPrice: null,
      executablePrice: null,
      priceVsBinanceBps: null,
      latencyMs: 0,
      tradable: false,
      message: 'No BSC token mapping for this pair. It may not be available on 1inch BSC.',
    }
  }

  const slippageBps = Math.min(2000, Math.max(10, req.slippageBps ?? 100))
  const src =
    req.side === 'BUY' ? ONEINCH_USDT : token.contractAddress
  const dst =
    req.side === 'BUY' ? token.contractAddress : ONEINCH_USDT
  const inDecimals = req.side === 'BUY' ? 18 : token.decimals
  const outDecimals = req.side === 'BUY' ? token.decimals : 18
  const amountIn = parseUnits(req.amount.toString(), inDecimals)

  let quote
  try {
    quote = await getOneInchQuote({ src, dst, amount: amountIn.toString() })
  } catch (err) {
    return {
      binanceSymbol: token.binanceSymbol,
      side: req.side,
      token,
      amountIn: amountIn.toString(),
      amountOut: '0',
      amountInHuman: req.amount,
      amountOutHuman: 0,
      binanceMidPrice: await fetchBinanceMid(token.binanceSymbol),
      executablePrice: null,
      priceVsBinanceBps: null,
      latencyMs: 0,
      tradable: false,
      message: err instanceof Error ? err.message : 'Quote failed',
    }
  }

  const outHuman = Number(formatUnits(BigInt(quote.dstAmount), outDecimals))
  const inHuman = Number(formatUnits(amountIn, inDecimals))
  const binanceMid = await fetchBinanceMid(token.binanceSymbol)
  let executablePrice: number | null = null
  let priceVsBinanceBps: number | null = null
  if (inHuman > 0 && outHuman > 0) {
    executablePrice = req.side === 'BUY' ? inHuman / outHuman : outHuman / inHuman
    if (binanceMid && binanceMid > 0 && executablePrice > 0) {
      priceVsBinanceBps = Math.round(((executablePrice - binanceMid) / binanceMid) * 10_000)
    }
  }

  return {
    binanceSymbol: token.binanceSymbol,
    side: req.side,
    token,
    amountIn: amountIn.toString(),
    amountOut: quote.dstAmount,
    amountInHuman: inHuman,
    amountOutHuman: outHuman,
    binanceMidPrice: binanceMid,
    executablePrice,
    priceVsBinanceBps,
    latencyMs: quote.latencyMs,
    tradable: outHuman > 0,
  }
}

export type OneInchSwapResult = {
  txHash: string
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

export async function executeOneInchSwap(userId: string, req: OneInchSwapRequest): Promise<OneInchSwapResult> {
  if (!isPersonalWalletEnabled()) {
    throw new Error('Personal wallet is not configured (WALLET_ENCRYPTION_KEY).')
  }
  if (!isOneInchConfigured()) {
    throw new Error('1inch is not configured (ONEINCH_API_KEY).')
  }
  if (!Number.isFinite(req.amount) || req.amount <= 0) {
    throw new Error('amount must be positive')
  }
  if (req.side === 'BUY' && req.amount < MIN_USDT_TRADE) {
    throw new Error(`Minimum buy size is ${MIN_USDT_TRADE} USDT on DEX 1inch.`)
  }

  const fresh = await previewOneInchSwap(req)
  if (!fresh.tradable) {
    throw new Error(fresh.message ?? 'No executable 1inch route for this pair.')
  }
  if (
    req.side === 'BUY' &&
    fresh.priceVsBinanceBps != null &&
    fresh.priceVsBinanceBps > MAX_BUY_VS_BINANCE_BPS
  ) {
    throw new Error(
      `1inch price is ${(fresh.priceVsBinanceBps / 100).toFixed(2)}% above Binance — trade blocked to protect PnL.`,
    )
  }

  const token = await resolveBscTokenForBinanceSymbol(req.binanceSymbol)
  if (!token) {
    throw new Error(`This pair is not available on BSC via 1inch (${req.binanceSymbol}).`)
  }

  const slippageBps = Math.min(2000, Math.max(10, req.slippageBps ?? 100))
  const slippagePercent = slippageBps / 100
  const src = req.side === 'BUY' ? ONEINCH_USDT : token.contractAddress
  const dst = req.side === 'BUY' ? token.contractAddress : ONEINCH_USDT
  const inDecimals = req.side === 'BUY' ? 18 : token.decimals
  const outDecimals = req.side === 'BUY' ? token.decimals : 18

  const signer = await getPersonalSigner(userId)
  const provider = getBscProvider()

  let amountIn: bigint
  if (req.side === 'BUY') {
    amountIn = parseUnits(req.amount.toString(), 18)
    const usdt = new Contract(ONEINCH_USDT, erc20Abi, provider)
    const bal = (await usdt.balanceOf(signer.address)) as bigint
    if (bal < amountIn) {
      throw new Error(`Insufficient USDT — need ${req.amount}, have ${formatUnits(bal, 18)}`)
    }
  } else {
    if (token.contractAddress.toLowerCase() === ONEINCH_NATIVE) {
      const nativeBal = await provider.getBalance(signer.address)
      amountIn = parseUnits(req.amount.toString(), 18)
      if (nativeBal < amountIn) {
        throw new Error(`Insufficient BNB — have ${formatUnits(nativeBal, 18)}`)
      }
    } else {
      const erc20 = new Contract(token.contractAddress, erc20Abi, provider)
      const bal = (await erc20.balanceOf(signer.address)) as bigint
      let desired = parseUnits(req.amount.toString(), token.decimals)
      if (desired > bal) desired = bal
      if (desired <= 0n) throw new Error(`Insufficient ${token.baseSymbol} balance`)
      amountIn = desired
    }
  }

  await ensureAllowance(signer, src, amountIn)

  const built = await buildOneInchSwap({
    src,
    dst,
    amount: amountIn.toString(),
    from: signer.address,
    slippagePercent,
  })

  const tx = (await signer.sendTransaction({
    to: built.tx.to,
    data: built.tx.data,
    value: BigInt(built.tx.value || '0'),
  })) as TransactionResponse
  await tx.wait(1)

  const expectedOut = BigInt(built.dstAmount)
  const amountInNum = Number(formatUnits(amountIn, inDecimals))
  const quotedOutNum = Number(formatUnits(expectedOut, outDecimals))

  const usdt = new Contract(ONEINCH_USDT, erc20Abi, provider)
  const usdtBefore = (await usdt.balanceOf(signer.address)) as bigint
  let counterBefore = 0n
  let counterAfter = 0n
  if (token.contractAddress.toLowerCase() !== ONEINCH_NATIVE) {
    const c = new Contract(token.contractAddress, erc20Abi, provider)
    counterBefore = (await c.balanceOf(signer.address)) as bigint
    counterAfter = counterBefore
  }

  const usdtAfter = (await usdt.balanceOf(signer.address)) as bigint
  if (token.contractAddress.toLowerCase() !== ONEINCH_NATIVE) {
    const c = new Contract(token.contractAddress, erc20Abi, provider)
    counterAfter = (await c.balanceOf(signer.address)) as bigint
  }

  let allocationUsd = 0
  let entryPriceEff = 0
  if (req.side === 'BUY') {
    const spent = Number(formatUnits(usdtBefore - usdtAfter, 18))
    const recv =
      token.contractAddress.toLowerCase() === ONEINCH_NATIVE
        ? quotedOutNum
        : Number(formatUnits(counterAfter - counterBefore, token.decimals))
    allocationUsd = Math.max(0, spent)
    entryPriceEff = recv > 1e-18 ? spent / recv : amountInNum / Math.max(quotedOutNum, 1e-18)
  } else {
    const recv = Number(formatUnits(usdtAfter - usdtBefore, 18))
    const sold =
      token.contractAddress.toLowerCase() === ONEINCH_NATIVE
        ? amountInNum
        : Number(formatUnits(counterBefore - counterAfter, token.decimals))
    allocationUsd = Math.max(0, recv)
    entryPriceEff = sold > 1e-18 ? recv / sold : quotedOutNum / Math.max(amountInNum, 1e-18)
  }

  const safeEntry =
    Number.isFinite(entryPriceEff) && entryPriceEff > 0
      ? entryPriceEff
      : req.side === 'BUY'
        ? amountInNum / Math.max(quotedOutNum, 1e-18)
        : quotedOutNum / Math.max(amountInNum, 1e-18)
  const safeAlloc = Number.isFinite(allocationUsd) ? Math.round(allocationUsd * 1e8) / 1e8 : 0
  const pair = `${token.baseSymbol}/USDT`
  const strategyId = await ensureOneInchStrategyId()

  logger.info(
    { userId, pair, side: req.side, txHash: tx.hash, venue: '1inch' },
    '[oneInch] swap filled',
  )

  let recordedTrade: OneInchSwapResult['trade']

  if (req.side === 'BUY') {
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
  } else {
    const openPos = await prisma.trade.findFirst({
      where: { userId, pair, strategyId, status: TradeStatus.OPEN },
      orderBy: { createdAt: 'asc' },
    })
    if (openPos) {
      const buyAlloc = Number(openPos.allocationUsd ?? 0)
      const buyEntry = Number(openPos.entryPrice)
      const realized = roundTripRealizedPnl(buyAlloc, buyEntry, safeEntry)
      const updated = await prisma.trade.update({
        where: { id: openPos.id },
        data: { exitPrice: safeEntry, pnl: realized, status: TradeStatus.CLOSED },
      })
      recordedTrade = {
        id: updated.id,
        pair,
        side: 'CLOSED',
        allocationUsd: buyAlloc,
        entryPrice: Number(updated.entryPrice),
        exitPrice: safeEntry,
        pnl: realized,
        status: 'CLOSED',
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
          status: TradeStatus.CLOSED,
        },
      })
      recordedTrade = {
        id: created.id,
        pair,
        side: 'SELL',
        allocationUsd: safeAlloc,
        entryPrice: safeEntry,
        exitPrice: null,
        pnl: null,
        status: 'CLOSED',
      }
    }
  }

  return {
    txHash: tx.hash,
    side: req.side,
    binanceSymbol: token.binanceSymbol,
    amountIn: amountIn.toString(),
    expectedOut: expectedOut.toString(),
    trade: recordedTrade,
  }
}

/** Dashboard "Sell now" for the DEX 1inch BSC book. */
export async function sellOneInchOpenPosition(
  userId: string,
  symbol: string,
): Promise<OneInchSwapResult> {
  const sym = symbol.toUpperCase()
  const strategyId = await ensureOneInchStrategyId()
  const pair = `${sym}/USDT`
  const openTrades = await prisma.trade.findMany({
    where: { userId, pair, strategyId, status: TradeStatus.OPEN },
    orderBy: { createdAt: 'asc' },
  })
  if (openTrades.length === 0) {
    throw new Error(`No open ${sym} position in the DEX 1inch trade book`)
  }

  const token = await resolveBscTokenForBinanceSymbol(`${sym}USDT`)
  if (!token) throw new Error(`Unsupported symbol ${sym} on 1inch BSC`)

  const lotQty = openTrades.reduce((sum, t) => {
    const entry = Number(t.entryPrice)
    const alloc = Number(t.allocationUsd ?? 0)
    return entry > 0 && alloc > 0 ? sum + alloc / entry : sum
  }, 0)
  if (lotQty <= 0) throw new Error(`No ${sym} quantity recorded for open 1inch trades`)

  const provider = getBscProvider()
  const signer = await getPersonalSigner(userId)
  let sellQty = lotQty
  if (token.contractAddress.toLowerCase() !== ONEINCH_NATIVE.toLowerCase()) {
    const erc20 = new Contract(token.contractAddress, erc20Abi, provider)
    const bal = (await erc20.balanceOf(signer.address)) as bigint
    const walletQty = Number(formatUnits(bal, token.decimals))
    if (walletQty > 0) sellQty = Math.min(lotQty, walletQty)
  } else {
    const nativeBal = await provider.getBalance(signer.address)
    const walletQty = Number(formatUnits(nativeBal, 18))
    if (walletQty > 0) sellQty = Math.min(lotQty, walletQty * 0.98)
  }
  if (sellQty <= 0) throw new Error(`No ${sym} balance in the personal wallet`)

  const result = await executeOneInchSwap(userId, {
    side: 'SELL',
    binanceSymbol: token.binanceSymbol,
    amount: sellQty,
    slippageBps: 100,
  })

  for (const t of openTrades.slice(1)) {
    await prisma.trade.update({
      where: { id: t.id },
      data: { status: TradeStatus.CANCELLED },
    })
  }

  return result
}
