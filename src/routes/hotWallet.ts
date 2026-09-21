import { Router, Request, Response } from 'express'
import { authenticateToken } from '../middleware/authenticateToken'
import { asyncHandler } from '../middleware/asyncHandler'
import { validate } from '../middleware/validate'
import { delegateSwapLimiter } from '../middleware/rateLimiter'
import { hotWalletDelegateSwapSchema } from '../validators'
import {
  getHotWalletSigner,
  getHotWalletOnChainSummary,
  isHotWalletConfigured,
} from '../services/wallet/hotWalletConfig'
import {
  executeDelegatedBuy,
  executeDelegatedSell,
  getDelegateBudgetState,
  listRecentDelegatedSpends,
} from '../services/wallet/hotWalletDelegate'
import { telegramService } from '../services/notifications/telegramService'

const router = Router()

function maskAddress(addr: string): string {
  if (addr.length < 12) return '***'
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/**
 * Authenticated read-only status for the optional BSC hot wallet (key from HOT_WALLET_PRIVATE_KEY only).
 */
router.get(
  '/status',
  authenticateToken,
  asyncHandler(async (_req: Request, res: Response) => {
    if (!isHotWalletConfigured()) {
      res.json({
        configured: false,
        message:
          'Set HOT_WALLET_PRIVATE_KEY in .env on the server. Never commit keys or paste them into chat.',
      })
      return
    }

    const signer = getHotWalletSigner()
    if (!signer) {
      res.status(500).json({ error: 'Hot wallet private key is invalid' })
      return
    }

    try {
      const summary = await getHotWalletOnChainSummary()
      if (!summary) {
        res.status(500).json({ error: 'Hot wallet unavailable' })
        return
      }
      res.json({
        configured: true,
        chainId: summary.chainId,
        address: summary.address,
        addressMasked: maskAddress(summary.address),
        balances: {
          bnb: summary.bnbFormatted,
          usdt: summary.usdtFormatted,
        },
      })
    } catch (e) {
      res.status(502).json({
        error: 'Failed to read BSC balances for hot wallet',
        detail: e instanceof Error ? e.message : String(e),
      })
    }
  })
)

router.get(
  '/delegate/status',
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const budget = await getDelegateBudgetState()
    let balances: { bnb: string; usdt: string } | null = null
    if (budget.hotWalletConfigured) {
      const s = await getHotWalletOnChainSummary()
      if (s) balances = { bnb: s.bnbFormatted, usdt: s.usdtFormatted }
    }
    const recent = await listRecentDelegatedSpends(userId, 20)
    res.json({ ...budget, balances, recent })
  })
)

router.post(
  '/delegate/swap',
  delegateSwapLimiter,
  authenticateToken,
  validate(hotWalletDelegateSwapSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const { direction, usdtAmount, wbnbAmount } = (
      req as Request & {
        validated: { direction: 'buy' | 'sell'; usdtAmount?: number; wbnbAmount?: number }
      }
    ).validated

    try {
      if (direction === 'buy') {
        const result = await executeDelegatedBuy(userId, usdtAmount!)
        void telegramService
          .notifyDexSwapExecuted({
            userId,
            walletLabel: 'Delegated hot wallet',
            side: 'BUY',
            tokenSymbol: 'WBNB',
            amountIn: `${usdtAmount} USDT`,
            expectedOut: result.wbnbAmountHuman ?? undefined,
            txHash: result.txHash,
          })
          .catch(() => null)
        res.status(201).json({ ok: true, result })
        return
      }
      const result = await executeDelegatedSell(userId, wbnbAmount)
      void telegramService
        .notifyDexSwapExecuted({
          userId,
          walletLabel: 'Delegated hot wallet',
          side: 'SELL',
          tokenSymbol: 'WBNB',
          amountIn: result.wbnbAmountHuman ?? undefined,
          expectedOut:
            result.usdtNotional !== undefined && Number.isFinite(result.usdtNotional)
              ? `${result.usdtNotional} USDT`
              : undefined,
          txHash: result.txHash,
        })
        .catch(() => null)
      res.status(201).json({ ok: true, result })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      void telegramService
        .notifyTradeFailed({
          userId,
          symbol: 'WBNB/USDT',
          side: direction === 'buy' ? 'BUY' : 'SELL',
          errorType: 'delegated_swap_failed',
          message: msg.slice(0, 1500),
        })
        .catch(() => null)
      throw err
    }
  })
)

export default router
