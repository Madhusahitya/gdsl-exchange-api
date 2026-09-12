/**
 * Unified trade entrypoint: on-chain PancakeSwap (BSC) vs centralized Binance.
 *
 * @example
 * await executeUnifiedTrade({
 *   platform: 'pancakeswap',
 *   tokenIn: 'BNB',
 *   tokenOut: 'USDT',
 *   amount: 0.002,
 * })
 */

import { executePancakeSwap } from './pancakeswapExecutor'

export type UnifiedTradeRequest = {
  platform: 'pancakeswap' | 'binance'
  tokenIn: string
  tokenOut: string
  amount: number
  /** Optional; defaults to env DEFAULT_CHAIN (must be BSC for Pancake). */
  chain?: string
}

export type UnifiedTradeResult = {
  platform: string
  chain: string
  txHash: string
  status: number
  blockNumber?: number
  tokenIn: string
  tokenOut: string
  amountIn: number
  details: Record<string, unknown>
}

export type BinanceUnifiedExecutor = (req: UnifiedTradeRequest) => Promise<UnifiedTradeResult>

function normalizeChain(c?: string): string {
  return (c ?? process.env.DEFAULT_CHAIN ?? 'BSC').trim().toUpperCase()
}

/**
 * Route by `platform` and `chain`:
 * - `pancakeswap` + BSC → `executePancakeSwap` (router + wallet from env).
 * - `binance` → requires `deps.binanceExecutor` (implement with `BinanceAdapter` in the API layer).
 */
export async function executeUnifiedTrade(
  req: UnifiedTradeRequest,
  deps?: { binanceExecutor?: BinanceUnifiedExecutor }
): Promise<UnifiedTradeResult> {
  const chain = normalizeChain(req.chain)

  if (req.platform === 'pancakeswap') {
    if (chain !== 'BSC' && chain !== 'BSC_MAINNET' && chain !== '56') {
      throw new Error(`PancakeSwap executor requires chain BSC (got ${chain})`)
    }
    const r = await executePancakeSwap({
      tokenIn: req.tokenIn,
      tokenOut: req.tokenOut,
      amountIn: req.amount,
    })
    return {
      platform: 'pancakeswap',
      chain: 'BSC',
      txHash: r.txHash,
      status: r.status,
      blockNumber: r.blockNumber,
      tokenIn: req.tokenIn,
      tokenOut: req.tokenOut,
      amountIn: req.amount,
      details: {
        amountInWei: r.amountInWei,
        amountOutMin: r.amountOutMin,
        expectedAmountOut: r.expectedAmountOut,
        gasEstimate: r.gasEstimate,
      },
    }
  }

  if (req.platform === 'binance') {
    if (!deps?.binanceExecutor) {
      throw new Error('Binance path requires deps.binanceExecutor (wire BinanceAdapter in apps/api)')
    }
    return deps.binanceExecutor(req)
  }

  throw new Error(`Unknown platform: ${(req as UnifiedTradeRequest).platform}`)
}
