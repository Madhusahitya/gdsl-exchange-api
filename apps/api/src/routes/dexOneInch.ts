import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { authenticateToken } from '../middleware/authenticateToken'
import { asyncHandler } from '../middleware/asyncHandler'
import { validate } from '../middleware/validate'
import { delegateSwapLimiter } from '../middleware/rateLimiter'
import { getBinanceUsdtMarketBoard } from '../services/trading/binanceMarketBoard'
import { getSocketIo } from '../lib/realtimeHub'
import {
  isPersonalWalletEnabled,
} from '../services/wallet/personalWalletService'
import { listCatalogBinanceSymbols } from '../lib/bscDexCatalog'
import {
  isValidBinanceUsdtSymbol,
  resolveBscTokenForBinanceSymbol,
} from '../services/dex/bscTokenResolver'
import { isOneInchConfigured } from '../services/dex/oneInchClassicService'
import {
  executeOneInchSwap,
  previewOneInchSwap,
} from '../services/dex/oneInchSwapService'

const router = Router()
router.use(authenticateToken)

const marketBoardQuery = z.object({
  limit: z.coerce.number().int().min(50).max(2000).optional(),
})

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
})

router.get(
  '/meta',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      venue: '1inch Classic',
      chainId: 56,
      chainName: 'BNB Smart Chain',
      oneInchConfigured: isOneInchConfigured(),
      personalWalletEnabled: isPersonalWalletEnabled(),
      minUsdtTrade: 50,
      catalogSymbols: listCatalogBinanceSymbols(),
      setupHint: isOneInchConfigured()
        ? null
        : 'Set ONEINCH_API_KEY in /opt/trade_bot/.env on the server, then: docker compose up -d api',
      note: 'Charts use Binance. Swaps execute at the 1inch-quoted price on BSC (not Binance mid).',
    })
  }),
)

router.get(
  '/market-board',
  validate(marketBoardQuery),
  asyncHandler(async (req: Request, res: Response) => {
    const q = (req as Request & { validated?: { limit?: number } }).validated ?? {}
    const limit = q.limit ?? 1500
    try {
      const board = await getBinanceUsdtMarketBoard(limit)
      res.json(board)
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Market board unavailable' })
    }
  }),
)

router.get(
  '/overview',
  validate(marketBoardQuery),
  asyncHandler(async (req: Request, res: Response) => {
    const q = (req as Request & { validated?: { limit?: number } }).validated ?? {}
    const limit = q.limit ?? 1500
    const board = await getBinanceUsdtMarketBoard(limit)
    const rows = board.rows
    const hot = [...rows].sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, 8)
    const topGainers = [...rows]
      .filter((r) => r.priceChangePercent > 0)
      .sort((a, b) => b.priceChangePercent - a.priceChangePercent)
      .slice(0, 8)
    const topLosers = [...rows]
      .filter((r) => r.priceChangePercent < 0)
      .sort((a, b) => a.priceChangePercent - b.priceChangePercent)
      .slice(0, 8)
    res.json({
      ...board,
      highlights: { hot, topGainers, topLosers },
      totalPairs: rows.length,
    })
  }),
)

router.get(
  '/resolve/:binanceSymbol',
  asyncHandler(async (req: Request, res: Response) => {
    const binanceSymbol = String(req.params.binanceSymbol ?? '').toUpperCase()
    if (!isValidBinanceUsdtSymbol(binanceSymbol)) {
      res.status(400).json({ error: 'Invalid Binance symbol' })
      return
    }
    const token = await resolveBscTokenForBinanceSymbol(binanceSymbol)
    let routeOk = Boolean(token)
    if (token && isOneInchConfigured()) {
      try {
        const probe = await previewOneInchSwap({
          side: 'BUY',
          binanceSymbol,
          amount: 50,
          slippageBps: 100,
        })
        routeOk = probe.tradable
      } catch {
        routeOk = false
      }
    }
    res.json({
      binanceSymbol,
      tradable: routeOk,
      token,
      message: routeOk
        ? undefined
        : token
          ? 'Token mapped on BSC but 1inch has no live route — try BNB, BTC, ETH, or USDC.'
          : 'This Binance pair has no BSC token in our catalog. Trade majors from the BSC list.',
    })
  }),
)

router.get(
  '/quote',
  validate(quoteQuery),
  asyncHandler(async (req: Request, res: Response) => {
    const v = (req as Request & { validated: z.infer<typeof quoteQuery> }).validated
    if (!isOneInchConfigured()) {
      res.status(503).json({ error: '1inch API key not configured on server' })
      return
    }
    const preview = await previewOneInchSwap({
      side: v.side,
      binanceSymbol: v.binanceSymbol,
      amount: v.amount,
      slippageBps: v.slippageBps,
    })
    res.json(preview)
  }),
)

router.post(
  '/swap',
  delegateSwapLimiter,
  validate(swapBody),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const body = (req as Request & { validated: z.infer<typeof swapBody> }).validated
    if (!isOneInchConfigured()) {
      res.status(503).json({ error: '1inch API key not configured on server' })
      return
    }
    const result = await executeOneInchSwap(userId, body)
    const io = getSocketIo()
    io?.to(`user:${userId}`).emit('trade:executed', {
      source: 'dex-1inch',
      ...result,
    })
    res.json(result)
  }),
)

export default router
