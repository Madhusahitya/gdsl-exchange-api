import { Contract, MaxUint256, formatUnits, parseUnits } from 'ethers'
import { prisma } from '@cryptoflow/db'
import {
  BSC_CHAIN_ID,
  PANCAKE_V2_ROUTER,
  SWAP_PATH_BUY,
  SWAP_PATH_SELL,
  USDT_BSC,
  WBNB,
  erc20Abi,
  pancakeRouterV2Abi,
} from '@cryptoflow/dex-pancake'
import { AppError } from '../../middleware/errorHandler'
import { getBscJsonRpcProvider, getHotWalletSigner, isHotWalletConfigured } from './hotWalletConfig'
import { logger } from '../../lib/logger'

const BUY_DIR = 'BUY_USDT_TO_WBNB' as const
const SELL_DIR = 'SELL_WBNB_TO_USDT' as const
const INVESTOR_DELEGATE_BUDGET_USDT = 500

function readEnvNumber(name: string, defaultVal: number): number {
  const v = process.env[name]
  if (!v?.trim()) return defaultVal
  const n = Number(v)
  return Number.isFinite(n) ? n : defaultVal
}

function delegateSlippageBps(): bigint {
  const v = readEnvNumber('HOT_WALLET_DELEGATE_SLIPPAGE_BPS', 100)
  const b = Math.floor(v)
  return BigInt(Math.min(2000, Math.max(10, b)))
}

export function isDelegateAutoSignEnabled(): boolean {
  return process.env.HOT_WALLET_DELEGATE_ENABLED?.trim().toLowerCase() === 'true'
}

export function getDelegateCaps() {
  const maxTotal = readEnvNumber('HOT_WALLET_DELEGATE_MAX_USDT_TOTAL', INVESTOR_DELEGATE_BUDGET_USDT)
  const maxPerTx = readEnvNumber('HOT_WALLET_DELEGATE_MAX_PER_TX_USDT', INVESTOR_DELEGATE_BUDGET_USDT)
  const safeTotal = Math.min(Math.max(maxTotal, 1), INVESTOR_DELEGATE_BUDGET_USDT)
  const safePerTx = Math.min(Math.max(maxPerTx, 1), safeTotal)
  return { maxTotalUsdt: safeTotal, maxPerTxUsdt: safePerTx }
}

async function sumDelegatedBuyUsdt(): Promise<number> {
  const agg = await prisma.hotWalletDelegatedSpend.aggregate({
    where: { direction: BUY_DIR },
    _sum: { usdtNotional: true },
  })
  const d = agg._sum.usdtNotional
  return d ? Number(d) : 0
}

export async function getDelegateBudgetState() {
  const used = await sumDelegatedBuyUsdt()
  const caps = getDelegateCaps()
  const outgoingAgg = await prisma.hotWalletDelegatedSpend.aggregate({
    where: { direction: BUY_DIR },
    _sum: { usdtNotional: true },
    _count: { _all: true },
  })
  const incomingAgg = await prisma.hotWalletDelegatedSpend.aggregate({
    where: { direction: SELL_DIR },
    _sum: { usdtNotional: true },
    _count: { _all: true },
  })
  const delegatedApprovalGranted = await hasHistoricalBuyApproval()
  return {
    enabled: isDelegateAutoSignEnabled(),
    hotWalletConfigured: isHotWalletConfigured(),
    chainId: BSC_CHAIN_ID,
    maxTotalUsdt: caps.maxTotalUsdt,
    maxPerTxUsdt: caps.maxPerTxUsdt,
    usedBuyUsdt: used,
    remainingBuyUsdt: Math.max(0, caps.maxTotalUsdt - used),
    slippageBps: Number(delegateSlippageBps()),
    delegatedApprovalGranted,
    delegatedApprovalPolicy: `One-time wallet signup approval only, capped at ${INVESTOR_DELEGATE_BUDGET_USDT} USDT total.`,
    transactionFlow: {
      outgoing: {
        count: outgoingAgg._count._all,
        usdt: Number(outgoingAgg._sum.usdtNotional ?? 0),
      },
      incoming: {
        count: incomingAgg._count._all,
        usdt: Number(incomingAgg._sum.usdtNotional ?? 0),
      },
    },
  }
}

function deadlineSec(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 20 * 60)
}

async function hasHistoricalBuyApproval(): Promise<boolean> {
  const existing = await prisma.hotWalletDelegatedSpend.findFirst({
    where: {
      direction: BUY_DIR,
      approveTxHash: { not: null },
    },
    select: { id: true },
  })
  return Boolean(existing)
}

async function ensureUsdtAllowance(
  signerAddress: `0x${string}`,
  amountIn: bigint,
  maxDelegatedTotalUsdt: number
): Promise<string | null> {
  const signer = getHotWalletSigner()
  if (!signer) throw new AppError(503, 'Hot wallet not configured')
  const usdt = new Contract(USDT_BSC, erc20Abi, signer)
  const allowance = await usdt.allowance(signerAddress, PANCAKE_V2_ROUTER)
  if (allowance >= amountIn) return null
  const alreadyApproved = await hasHistoricalBuyApproval()
  if (alreadyApproved) {
    throw new AppError(
      400,
      'Delegated approval is one-time only (max 500 USDT). Remaining allowance is not enough for this trade.'
    )
  }
  const delegatedCap = parseUnits(String(maxDelegatedTotalUsdt), 18)
  const tx = await usdt.approve(PANCAKE_V2_ROUTER, delegatedCap)
  logger.info({ hash: tx.hash }, 'hotWallet.delegate usdt approve')
  const receipt = await tx.wait()
  if (!receipt?.status) throw new AppError(502, 'USDT approve failed')
  return tx.hash
}

export type DelegateSwapResult = {
  direction: typeof BUY_DIR | typeof SELL_DIR
  txHash: string
  approveTxHash: string | null
 usdtNotional: number
  wbnbAmountHuman: string | null
}

export async function executeDelegatedBuy(userId: string, usdtAmount: number): Promise<DelegateSwapResult> {
  if (!isDelegateAutoSignEnabled()) {
    throw new AppError(403, 'Delegated auto-sign is disabled (set HOT_WALLET_DELEGATE_ENABLED=true)')
  }
  const signer = getHotWalletSigner()
  if (!signer) throw new AppError(503, 'Hot wallet not configured')

  const caps = getDelegateCaps()
  const used = await sumDelegatedBuyUsdt()
  const remaining = Math.max(0, caps.maxTotalUsdt - used)
  if (remaining <= 0) throw new AppError(400, 'Delegated USDT budget exhausted')
  if (usdtAmount < 5) throw new AppError(400, 'Minimum delegated buy is 5 USDT')
  if (usdtAmount > caps.maxPerTxUsdt) throw new AppError(400, `Per-tx cap is ${caps.maxPerTxUsdt} USDT`)
  if (usdtAmount > remaining) throw new AppError(400, `Only ${remaining.toFixed(2)} USDT remaining in delegated budget`)

  const provider = getBscJsonRpcProvider()
  const usdtRead = new Contract(USDT_BSC, erc20Abi, provider)
  const amountIn = parseUnits(String(usdtAmount), 18)
  const bal = await usdtRead.balanceOf(signer.address)
  if (bal < amountIn) throw new AppError(400, 'Insufficient USDT balance on hot wallet')

  const approveTxHash = await ensureUsdtAllowance(
    signer.address as `0x${string}`,
    amountIn,
    caps.maxTotalUsdt
  )

  const router = new Contract(PANCAKE_V2_ROUTER, pancakeRouterV2Abi, signer)
  const path = [...SWAP_PATH_BUY]
  const amounts = (await router.getAmountsOut(amountIn, path)) as bigint[]
  const expectedOut = amounts[1]
  if (!expectedOut) throw new AppError(502, 'Router returned no quote')
  const bps = delegateSlippageBps()
  const amountOutMin = (expectedOut * (10_000n - bps)) / 10_000n

  const swapTx = await router.swapExactTokensForTokens(
    amountIn,
    amountOutMin,
    path,
    signer.address,
    deadlineSec()
  )
  logger.info({ hash: swapTx.hash, usdtAmount }, 'hotWallet.delegate buy swap')
  const receipt = await swapTx.wait()
  if (!receipt?.status) throw new AppError(502, 'Buy swap failed')

  await prisma.hotWalletDelegatedSpend.create({
    data: {
      userId,
      direction: BUY_DIR,
      usdtNotional: usdtAmount,
      wbnbAmount: null,
      txHash: swapTx.hash,
      approveTxHash,
    },
  })

  return {
    direction: BUY_DIR,
    txHash: swapTx.hash,
    approveTxHash,
    usdtNotional: usdtAmount,
    wbnbAmountHuman: formatUnits(expectedOut, 18),
  }
}

async function ensureWbnbAllowance(signerAddress: `0x${string}`, amountIn: bigint): Promise<string | null> {
  const signer = getHotWalletSigner()
  if (!signer) throw new AppError(503, 'Hot wallet not configured')
  const wbnb = new Contract(WBNB, erc20Abi, signer)
  const allowance = await wbnb.allowance(signerAddress, PANCAKE_V2_ROUTER)
  if (allowance >= amountIn) return null
  const tx = await wbnb.approve(PANCAKE_V2_ROUTER, MaxUint256)
  logger.info({ hash: tx.hash }, 'hotWallet.delegate wbnb approve')
  const receipt = await tx.wait()
  if (!receipt?.status) throw new AppError(502, 'WBNB approve failed')
  return tx.hash
}

export async function executeDelegatedSell(
  userId: string,
  wbnbAmountHuman?: number
): Promise<DelegateSwapResult> {
  if (!isDelegateAutoSignEnabled()) {
    throw new AppError(403, 'Delegated auto-sign is disabled (set HOT_WALLET_DELEGATE_ENABLED=true)')
  }
  const signer = getHotWalletSigner()
  if (!signer) throw new AppError(503, 'Hot wallet not configured')

  const provider = getBscJsonRpcProvider()
  const wbnbRead = new Contract(WBNB, erc20Abi, provider)
  const bal = await wbnbRead.balanceOf(signer.address)
  if (bal === 0n) throw new AppError(400, 'No WBNB balance on hot wallet')

  let amountIn: bigint
  if (wbnbAmountHuman !== undefined && Number.isFinite(wbnbAmountHuman)) {
    if (wbnbAmountHuman <= 0) throw new AppError(400, 'wbnbAmount must be positive')
    amountIn = parseUnits(String(wbnbAmountHuman), 18)
    if (amountIn > bal) throw new AppError(400, 'wbnbAmount exceeds WBNB balance')
  } else {
    amountIn = bal
  }

  const minOut = parseUnits('0.01', 18)
  if (amountIn < minOut) throw new AppError(400, 'WBNB amount too small to swap')

  const approveTxHash = await ensureWbnbAllowance(signer.address as `0x${string}`, amountIn)

  const router = new Contract(PANCAKE_V2_ROUTER, pancakeRouterV2Abi, signer)
  const path = [...SWAP_PATH_SELL]
  const amounts = (await router.getAmountsOut(amountIn, path)) as bigint[]
  const expectedUsdt = amounts[1]
  if (!expectedUsdt) throw new AppError(502, 'Router returned no quote')
  const bps = delegateSlippageBps()
  const amountOutMin = (expectedUsdt * (10_000n - bps)) / 10_000n

  const swapTx = await router.swapExactTokensForTokens(
    amountIn,
    amountOutMin,
    path,
    signer.address,
    deadlineSec()
  )
  logger.info({ hash: swapTx.hash }, 'hotWallet.delegate sell swap')
  const receipt = await swapTx.wait()
  if (!receipt?.status) throw new AppError(502, 'Sell swap failed')

  const wbnbHuman = formatUnits(amountIn, 18)
  const usdtHuman = Number(formatUnits(expectedUsdt, 18))

  await prisma.hotWalletDelegatedSpend.create({
    data: {
      userId,
      direction: SELL_DIR,
      usdtNotional: 0,
      wbnbAmount: wbnbHuman,
      txHash: swapTx.hash,
      approveTxHash,
    },
  })

  return {
    direction: SELL_DIR,
    txHash: swapTx.hash,
    approveTxHash,
    usdtNotional: usdtHuman,
    wbnbAmountHuman: wbnbHuman,
  }
}

export async function listRecentDelegatedSpends(userId: string, take = 20) {
  return prisma.hotWalletDelegatedSpend.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      direction: true,
      usdtNotional: true,
      wbnbAmount: true,
      txHash: true,
      approveTxHash: true,
      createdAt: true,
    },
  })
}
