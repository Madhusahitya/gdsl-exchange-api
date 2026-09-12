/**
 * PancakeSwap V2 on BSC — on-chain swap execution via ethers.
 * Router ABI and addresses are imported from @cryptoflow/dex-pancake; env overrides RPC/router/WBNB.
 */

import {
  Contract,
  ContractTransactionResponse,
  JsonRpcProvider,
  MaxUint256,
  Wallet,
  formatEther,
  formatUnits,
  getAddress,
  parseEther,
  parseUnits,
} from 'ethers'
import {
  USDT_BSC,
  WBNB as WBNB_DEFAULT,
  pancakeRouterV2Abi,
  erc20Abi,
} from '@cryptoflow/dex-pancake'

const NATIVE = 'BNB'

export class PancakeSwapExecutorError extends Error {
  constructor(
    message: string,
    public readonly code: 'CONFIG' | 'CHAIN' | 'LIQUIDITY' | 'GAS' | 'SLIPPAGE' | 'TX' | 'NETWORK'
  ) {
    super(message)
    this.name = 'PancakeSwapExecutorError'
  }
}

function envStr(name: string, fallback?: string): string {
  const v = process.env[name]?.trim()
  if (v) return v
  if (fallback !== undefined) return fallback
  throw new PancakeSwapExecutorError(`Missing env ${name}`, 'CONFIG')
}

function routerAddress(): string {
  return envStr('PANCAKESWAP_ROUTER_ADDRESS', '0x10ED43C718714eb63d5aA57B78B54704E256024E')
}

function wbnbAddress(): string {
  return envStr('WBNB_ADDRESS', WBNB_DEFAULT)
}

function bscRpcUrl(): string {
  return envStr('BSC_RPC_URL', 'https://bsc-dataseed.binance.org')
}

function defaultChain(): string {
  return (process.env.DEFAULT_CHAIN ?? 'BSC').trim().toUpperCase()
}

function readSlippageBps(): bigint {
  const bpsRaw = process.env.MAX_SLIPPAGE_BPS?.trim()
  if (bpsRaw) {
    const n = parseInt(bpsRaw, 10)
    if (Number.isFinite(n)) return BigInt(Math.min(5000, Math.max(1, n)))
  }
  /** MAX_SLIPPAGE as decimal fraction of notional (e.g. 0.01 = 1% = 100 bps). Max 0.5 (50%). */
  const frac = process.env.MAX_SLIPPAGE?.trim()
  if (frac) {
    const f = parseFloat(frac)
    if (Number.isFinite(f) && f > 0 && f <= 0.5) {
      return BigInt(Math.min(5000, Math.max(1, Math.round(f * 10_000))))
    }
  }
  return 100n
}

function gasBufferNumerator(): bigint {
  const n = parseInt(process.env.PANCAKE_GAS_BUFFER_BPS ?? '12000', 10)
  return BigInt(Number.isFinite(n) ? Math.min(20_000, Math.max(10_000, n)) : 12_000)
}

function minOutputHumanThreshold(): number | null {
  const v = process.env.PANCAKE_MIN_OUTPUT_HUMAN?.trim()
  if (!v) return null
  const n = parseFloat(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

function privateKey(): string {
  const k =
    process.env.BSC_TRADER_PRIVATE_KEY?.trim() ||
    process.env.HOT_WALLET_PRIVATE_KEY?.trim() ||
    process.env.PRIVATE_KEY?.trim()
  if (!k) {
    throw new PancakeSwapExecutorError(
      'Set BSC_TRADER_PRIVATE_KEY or HOT_WALLET_PRIVATE_KEY for on-chain signing',
      'CONFIG'
    )
  }
  const hex = k.startsWith('0x') ? k : `0x${k}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new PancakeSwapExecutorError('Invalid private key format', 'CONFIG')
  }
  return hex
}

function normSymbol(s: string): string {
  return s.trim().toUpperCase()
}

function resolveTokenAddress(symbol: string): { address: string; isNative: boolean; decimals: number } {
  const s = normSymbol(symbol)
  if (s === NATIVE || s === 'WBNB') {
    return { address: getAddress(wbnbAddress()), isNative: s === NATIVE, decimals: 18 }
  }
  if (s === 'USDT') {
    return { address: getAddress(USDT_BSC), isNative: false, decimals: 18 }
  }
  throw new PancakeSwapExecutorError(`Unsupported token symbol: ${symbol}`, 'CONFIG')
}

function buildPath(tokenIn: string, tokenOut: string): { path: string[]; usesEthIn: boolean; usesEthOut: boolean } {
  const a = resolveTokenAddress(tokenIn)
  const b = resolveTokenAddress(tokenOut)
  const w = getAddress(wbnbAddress())
  let path: string[]
  if (a.isNative || normSymbol(tokenIn) === 'WBNB') {
    if (b.isNative || normSymbol(tokenOut) === 'WBNB') {
      throw new PancakeSwapExecutorError('Cannot swap BNB to BNB', 'CONFIG')
    }
    path = [w, b.address]
  } else if (b.isNative || normSymbol(tokenOut) === 'WBNB') {
    path = [a.address, w]
  } else {
    path = [a.address, w, b.address]
  }
  const usesEthIn = a.isNative
  const usesEthOut = b.isNative
  return { path, usesEthIn, usesEthOut }
}

function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 20 * 60)
}

async function withRetry<T>(label: string, fn: () => Promise<T>, retries = 3, baseMs = 400): Promise<T> {
  let last: unknown
  for (let i = 0; i < retries; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (i === retries - 1) break
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i))
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

export type PancakeSwapParams = {
  tokenIn: string
  tokenOut: string
  /** Human amount: BNB in ether units, ERC20 in token decimals (USDT 18 on BSC). */
  amountIn: number
}

export type PancakeSwapResult = {
  txHash: string
  status: number
  blockNumber?: number
  tokenIn: string
  tokenOut: string
  amountInWei: string
  amountOutMin: string
  expectedAmountOut: string
  gasEstimate?: string
}

function assertBscChain() {
  const c = defaultChain()
  if (c !== 'BSC' && c !== 'BSC_MAINNET' && c !== '56') {
    throw new PancakeSwapExecutorError(`DEFAULT_CHAIN must be BSC for Pancake executor (got ${c})`, 'CHAIN')
  }
}

function parseAmountInWei(tokenIn: string, amount: number): bigint {
  const s = normSymbol(tokenIn)
  if (s === NATIVE || s === 'WBNB') {
    return parseEther(String(amount))
  }
  const { decimals } = resolveTokenAddress(tokenIn)
  return parseUnits(String(amount), decimals)
}

/**
 * Quote and execute a swap on PancakeSwap V2.
 * - BNB in: swapExactETHForTokens
 * - BNB out: swapExactTokensForETH
 * - ERC20 ↔ ERC20: swapExactTokensForTokens
 */
export async function executePancakeSwap(params: PancakeSwapParams): Promise<PancakeSwapResult> {
  assertBscChain()
  const slippageBps = readSlippageBps()
  const provider = new JsonRpcProvider(bscRpcUrl(), { chainId: 56, name: 'bnb' })
  const signer = new Wallet(privateKey(), provider)
  const router = new Contract(routerAddress(), pancakeRouterV2Abi, signer)
  const { path, usesEthIn, usesEthOut } = buildPath(params.tokenIn, params.tokenOut)
  const amountInWei = parseAmountInWei(params.tokenIn, params.amountIn)
  if (amountInWei <= 0n) {
    throw new PancakeSwapExecutorError('amountIn must be positive', 'CONFIG')
  }

  const amounts = (await withRetry('getAmountsOut', () =>
    router.getAmountsOut(amountInWei, path)
  )) as bigint[]
  const expectedOut = amounts[amounts.length - 1]
  if (!expectedOut || expectedOut === 0n) {
    throw new PancakeSwapExecutorError('Router returned zero output — insufficient liquidity', 'LIQUIDITY')
  }

  const amountOutMin = (expectedOut * (10_000n - slippageBps)) / 10_000n
  if (amountOutMin === 0n) {
    throw new PancakeSwapExecutorError('amountOutMin collapsed to zero — increase size or lower slippage', 'SLIPPAGE')
  }

  const symOut = normSymbol(params.tokenOut)
  const decOut = symOut === NATIVE || symOut === 'WBNB' ? 18 : resolveTokenAddress(params.tokenOut).decimals
  const outHuman = parseFloat(formatUnits(expectedOut, decOut))
  const minHuman = minOutputHumanThreshold()
  if (minHuman !== null && outHuman < minHuman) {
    throw new PancakeSwapExecutorError(
      `Expected output ${outHuman} below PANCAKE_MIN_OUTPUT_HUMAN (${minHuman})`,
      'LIQUIDITY'
    )
  }

  const buf = gasBufferNumerator()
  const feeData = await provider.getFeeData()
  const gasPrice = feeData.gasPrice ?? (await provider.getFeeData()).gasPrice ?? 0n
  if (gasPrice === 0n) {
    throw new PancakeSwapExecutorError('Could not resolve gas price', 'GAS')
  }

  let gasEstimate: bigint
  const to = signer.address
  const dl = deadline()

  if (usesEthIn) {
    gasEstimate = await withRetry('estimateGas:eth', () =>
      router.swapExactETHForTokens.estimateGas(amountOutMin, path, to, dl, { value: amountInWei })
    )
 } else if (usesEthOut) {
    const tokenInAddr = resolveTokenAddress(params.tokenIn).address
    const erc20 = new Contract(tokenInAddr, erc20Abi, signer)
    const allowance = await erc20.allowance(signer.address, routerAddress())
    if (allowance < amountInWei) {
      const approveTx = await withRetry('approve', () => erc20.approve(routerAddress(), MaxUint256))
      const ar = await approveTx.wait()
      if (!ar?.status) throw new PancakeSwapExecutorError('Approve failed', 'TX')
    }
    gasEstimate = await withRetry('estimateGas:tokensForEth', () =>
      router.swapExactTokensForETH.estimateGas(amountInWei, amountOutMin, path, to, dl)
    )
  } else {
    const tokenInAddr = resolveTokenAddress(params.tokenIn).address
    const erc20 = new Contract(tokenInAddr, erc20Abi, signer)
    const routerAddr = getAddress(routerAddress())
    const allowance = await erc20.allowance(signer.address, routerAddr)
    if (allowance < amountInWei) {
      const approveTx = await withRetry('approve', () => erc20.approve(routerAddr, MaxUint256))
      const ar = await approveTx.wait()
      if (!ar?.status) throw new PancakeSwapExecutorError('Approve failed', 'TX')
    }
    gasEstimate = await withRetry('estimateGas:tokenToToken', () =>
      router.swapExactTokensForTokens.estimateGas(amountInWei, amountOutMin, path, to, dl)
    )
  }

  const gasCostBuffered = (gasEstimate * gasPrice * buf) / 10_000n
  const bnbBal = await provider.getBalance(signer.address)
  const valueForTx = usesEthIn ? amountInWei : 0n
  if (bnbBal < gasCostBuffered + valueForTx) {
    throw new PancakeSwapExecutorError(
      `Insufficient BNB for gas + value: need ~${formatEther(gasCostBuffered + valueForTx)} BNB`,
      'GAS'
    )
  }

  let tx: ContractTransactionResponse
  if (usesEthIn) {
    tx = await withRetry('send:ethForTokens', () =>
      router.swapExactETHForTokens(amountOutMin, path, to, dl, { value: amountInWei })
    )
  } else if (usesEthOut) {
    tx = await withRetry('send:tokensForEth', () =>
      router.swapExactTokensForETH(amountInWei, amountOutMin, path, to, dl)
    )
  } else {
    tx = await withRetry('send:tokensForTokens', () =>
      router.swapExactTokensForTokens(amountInWei, amountOutMin, path, to, dl)
    )
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: 'info', msg: 'pancakeswap.tx.submitted', hash: tx.hash }))

  const receipt = await withRetry('tx.wait', () => tx.wait(1), 5, 800)
  if (!receipt) {
    throw new PancakeSwapExecutorError('No receipt from network', 'NETWORK')
  }
  const status = receipt.status ?? 0
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      level: status === 1 ? 'info' : 'error',
      msg: 'pancakeswap.tx.mined',
      hash: receipt.hash,
      status,
      blockNumber: receipt.blockNumber,
    })
  )
  if (status !== 1) {
    throw new PancakeSwapExecutorError(`Swap reverted (tx ${receipt.hash})`, 'TX')
  }

  return {
    txHash: receipt.hash,
    status,
    blockNumber: receipt.blockNumber,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountInWei: amountInWei.toString(),
    amountOutMin: amountOutMin.toString(),
    expectedAmountOut: expectedOut.toString(),
    gasEstimate: gasEstimate.toString(),
  }
}
