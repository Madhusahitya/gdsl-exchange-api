import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { authenticateToken } from '../middleware/authenticateToken'
import { asyncHandler } from '../middleware/asyncHandler'
import { validate } from '../middleware/validate'
import { isPersonalWalletEnabled, PERSONAL_WALLET_TOKENS } from '../services/wallet/personalWalletService'
import { syncTokenTradingInboxMessages } from '../services/trading/tokenTradingAlertSync'
import { getBinanceUsdtMarketBoard } from '../services/trading/binanceMarketBoard'
import { runTokenTradingFocus } from '../services/trading/tokenTradingFocus'

const router = Router()
router.use(authenticateToken)

const lastSyncAt = new Map<string, number>()
const MIN_INTERVAL_MS = 4 * 60 * 1000

/** Per-user + symbol throttle so rapid A↔B switching is allowed. */
const lastFocusAt = new Map<string, number>()
const FOCUS_MIN_MS = 2000

const walletSnapshotSchema = z.object({
  mode: z.enum(['personal', 'external']),
  /** e.g. MetaMask, Trust Wallet, injected */
  label: z.string().max(48).optional(),
  /** Last chars of address for display only */
  addressTail: z.string().max(16).optional(),
  usdtBalance: z.number().finite().min(0).max(1e15).optional(),
  /** Estimated USD value of base token holding for this pair */
  baseUsdApprox: z.number().finite().min(0).max(1e15).optional(),
})

const focusSchema = z.object({
  binanceSymbol: z
    .string()
    .min(6)
    .max(32)
    .regex(/^[A-Z0-9]+USDT$/i)
    .transform((s) => s.toUpperCase()),
  chain: z.enum(['bsc', 'base', 'arbitrum', 'polygon']).optional(),
  venue: z.enum(['pancakeswap', 'uniswap', 'auto']).optional(),
  wallet: walletSnapshotSchema.optional(),
})

type FocusValidatedBody = z.infer<typeof focusSchema>

const marketBoardQuery = z.object({
  limit: z.coerce.number().int().min(50).max(500).optional(),
})

router.get(
  '/market-board',
  validate(marketBoardQuery),
  asyncHandler(async (req: Request, res: Response) => {
    const q = (req as Request & { validated?: { limit?: number } }).validated ?? {}
    const limit = q.limit ?? 400
    try {
      const board = await getBinanceUsdtMarketBoard(limit)
      res.json(board)
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Market board unavailable' })
    }
  }),
)

router.post(
  '/focus-token',
  validate(focusSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const { binanceSymbol, chain, venue, wallet } = (req as Request & { validated: FocusValidatedBody }).validated
    const now = Date.now()
    const key = `${userId}:${binanceSymbol}`
    const prev = lastFocusAt.get(key) ?? 0
    if (now - prev < FOCUS_MIN_MS) {
      res.status(429).json({ error: 'Too fast', retryAfterMs: FOCUS_MIN_MS - (now - prev) })
      return
    }
    lastFocusAt.set(key, now)
    try {
      const payload = await runTokenTradingFocus(userId, binanceSymbol, { chain, venue, wallet })
      res.json(payload)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Focus failed'
      res.status(400).json({ error: msg })
    }
  }),
)

router.get(
  '/meta',
  asyncHandler(async (req: Request, res: Response) => {
    const symbols = PERSONAL_WALLET_TOKENS.map((t) => t.symbol).filter(Boolean)
    res.json({
      executionChain: 'BNB Smart Chain (56)',
      primaryVenue: 'PancakeSwap V2',
      noteOtherVenues:
        'Uniswap and other DEXs on other chains are not executed by this API; swaps are routed on BSC only.',
      personalWalletEnabled: isPersonalWalletEnabled(),
      supportedSymbols: symbols,
    })
  }),
)

router.post(
  '/sync-alerts',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const now = Date.now()
    const prev = lastSyncAt.get(userId) ?? 0
    if (now - prev < MIN_INTERVAL_MS) {
      const retrySec = Math.ceil((MIN_INTERVAL_MS - (now - prev)) / 1000)
      res.status(429).json({
        error: 'Too many sync requests',
        retryAfterSec: retrySec,
      })
      return
    }
    lastSyncAt.set(userId, now)
    const result = await syncTokenTradingInboxMessages(userId)
    res.json(result)
  }),
)

export default router
