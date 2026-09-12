import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { authenticateToken } from '../middleware/authenticateToken'
import { asyncHandler } from '../middleware/asyncHandler'
import { validate } from '../middleware/validate'
import { delegateSwapLimiter } from '../middleware/rateLimiter'
import { getSocketIo } from '../lib/realtimeHub'
import {
  executeSmartTrade,
  getSmartExecutionQuote,
} from '../services/trading/executionRouterService'
import { isPersonalWalletEnabled } from '../services/wallet/personalWalletService'
import { isOneInchConfigured } from '../services/dex/oneInchClassicService'
import { env } from '../lib/env'

const router = Router()
router.use(authenticateToken)

const quoteQuery = z.object({
  binanceSymbol: z
    .string()
    .min(6)
    .max(32)
    .regex(/^[A-Z0-9]{2,28}USDT$/i)
    .transform((s) => s.toUpperCase()),
  side: z.enum(['BUY', 'SELL']),
  amount: z.coerce.number().positive().max(1_000_000),
  slippageBps: z.coerce.number().int().min(10).max(2000).optional(),
})

const swapBody = z.object({
  side: z.enum(['BUY', 'SELL']),
  binanceSymbol: z
    .string()
    .min(6)
    .max(32)
    .regex(/^[A-Z0-9]{2,28}USDT$/i)
    .transform((s) => s.toUpperCase()),
  amount: z.number().positive().max(1_000_000),
  slippageBps: z.number().int().min(10).max(2000).optional(),
  venue: z.enum(['binance', 'oneinch_bsc']).optional(),
})

router.get(
  '/meta',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      name: 'Smart execution router',
      description: 'Compares Binance Spot vs 1inch BSC and trades the better price.',
      minUsdt: env.smartRouterMinUsdt,
      maxBuyVsBinanceBps: env.smartRouterMaxBuyVsBinanceBps,
      oneInchConfigured: isOneInchConfigured(),
      personalWalletEnabled: isPersonalWalletEnabled(),
      note: 'Connect Binance API on Exchange page for CEX leg. Personal wallet required for DEX leg.',
    })
  }),
)

router.get(
  '/quote',
  validate(quoteQuery),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const v = (req as Request & { validated: z.infer<typeof quoteQuery> }).validated
    const quote = await getSmartExecutionQuote(userId, v)
    res.json(quote)
  }),
)

router.post(
  '/swap',
  delegateSwapLimiter,
  validate(swapBody),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const body = (req as Request & { validated: z.infer<typeof swapBody> }).validated
    const result = await executeSmartTrade(userId, body)
    const io = getSocketIo()
    io?.to(`user:${userId}`).emit('trade:executed', {
      source: 'smart-router',
      ...result,
    })
    res.json(result)
  }),
)

export default router
