import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { PublicKey } from '@solana/web3.js'
import { authenticateToken } from '../middleware/authenticateToken'
import { asyncHandler } from '../middleware/asyncHandler'
import { validate } from '../middleware/validate'
import { delegateSwapLimiter } from '../middleware/rateLimiter'
import { getSocketIo } from '../lib/realtimeHub'
import {
  isSolanaWalletEnabled,
  ensureSolanaPersonalWallet,
  getSolanaWalletStatus,
  getSolanaTokenBalance,
  getSolanaBalances,
  getSolanaWalletDashboardSummary,
  listSolanaHoldings,
  listSolanaHoldingsForOwner,
  withdrawFromSolanaWallet,
  listSolanaWithdrawals,
  SOLANA_WITHDRAW_ASSETS,
} from '../services/wallet/solanaPersonalWalletService'
import { listSolCatalogBinanceSymbols, SOL_USDC_MINT, SOL_NATIVE_MINT } from '../lib/solDexCatalog'
import { fetchJupiterPricesV3Batched } from '../services/dex/jupiterPriceService'
import {
  isValidBinanceUsdtSymbol,
} from '../services/dex/solTokenResolver'
import { getJupiterTradableRegistry, getJupiterTradableToken } from '../services/dex/jupiterTradableRegistry'
import { isJupiterConfigured } from '../services/dex/jupiterClassicService'
import {
  executeJupiterSwap,
  previewJupiterSwap,
  getJupiterOpenPositions,
  previewSolanaConvert,
  convertSolanaTokens,
  sellJupiterOpenPosition,
  reconcileStaleJupiterOpenTrades,
  setJupiterPositionExitOverrides,
  skimJupiterPositionProfit,
} from '../services/dex/jupiterSwapService'
import {
  buildBrowserJupiterSwap,
  listSelfCustodyPositions,
  submitBrowserJupiterSwap,
} from '../services/dex/jupiterBrowserSwapService'
import {
  getJupiterDesk,
  previewJupiterManualTrade,
} from '../services/dex/jupiterManualDeskService'
import { compareExecutionRoutes } from '../services/dex/executionEngineService'
import { getJupiterTradeJournal } from '../services/dex/jupiterJournalService'
import {
  getJupiterExitSettings,
  setJupiterExitSettings,
} from '../services/dex/jupiterExitSettingsService'
import {
  getJupiterAutopilotSettings,
  setJupiterAutopilotSettings,
} from '../services/dex/jupiterAutopilotService'
import {
  cancelJupiterLimitOrder,
  createJupiterLimitOrder,
  getJupiterLimitOrders,
} from '../services/dex/jupiterLimitOrderService'
import {
  getSuperMachineSettings,
  setSuperMachineSettings,
  getSuperMachineStatus,
} from '../services/agents/superMachineService'
import { getCouncilStatus, getCouncilDecisionHistory } from '../services/agents/councilService'
import { getJupiterTradeSignals } from '../services/dex/jupiterSignalService'
import {
  buyJupiterPrediction,
  claimJupiterPredictionPosition,
  closeJupiterPredictionPosition,
  getJupiterPredictionHistory,
  getJupiterPredictionPositions,
  listJupiterPredictionEvents,
  searchJupiterPredictionEvents,
} from '../services/dex/jupiterPredictionService'
import { buildEventInsights } from '../services/dex/predictionEdgeService'
import { getJupiterLiveMarketBoard } from '../services/dex/jupiterMarketBoardService'
import { getJupiterAlignedCandles, getJupiterLivePrice } from '../services/dex/jupiterCandleService'
import { telegramService } from '../services/notifications/telegramService'
import { getJupiterExecutableMarks } from '../services/dex/jupiterMarkService'
import { getJupiterSyntheticDepth } from '../services/dex/jupiterDepthService'
import { getJupiterTradeSuggestions } from '../services/dex/jupiterTrendingService'

const router = Router()
router.use(authenticateToken)

const positionsCache = new Map<
  string,
  {
    at: number
    payload: {
      positions: Awaited<ReturnType<typeof getJupiterOpenPositions>>
      totalNetPnlUsd: number
      totalValueUsd: number
      totalBankedSkimUsd: number
      updatedAt: string
    }
  }
>()
const POSITIONS_CACHE_MS = 2_500

const quotePreviewCache = new Map<string, { at: number; body: Awaited<ReturnType<typeof previewJupiterSwap>> }>()
const QUOTE_PREVIEW_CACHE_MS = 4_000
const QUOTE_PREVIEW_STALE_MS = 45_000

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
  spendAsset: z.enum(['USDC', 'SOL']).optional(),
  /** Any SPL mint the user holds to pay with on a BUY (base58). */
  spendMint: z.string().min(32).max(48).optional(),
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
  spendAsset: z.enum(['USDC', 'SOL']).optional(),
  /** Any SPL mint the user holds to pay with on a BUY (base58). */
  spendMint: z.string().min(32).max(48).optional(),
  skipEntryGuard: z.boolean().optional(),
  /** When true (default), execution engine picks best Jupiter venue filter before fill. */
  smartRoute: z.boolean().optional(),
})

const candlesQuery = z.object({
  interval: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']).optional(),
  limit: z.coerce.number().int().min(20).max(500).optional(),
})

const exitSettingsBody = z.object({
  enabled: z.boolean().optional(),
  takeProfitPct: z.number().min(0.1).max(50).optional(),
  stopLossPct: z.number().min(0.1).max(50).optional(),
  trailingStop: z.boolean().optional(),
  profitSkim: z.boolean().optional(),
  trailingActivationPct: z.number().min(0.2).max(10).optional(),
  trailingDeltaPct: z.number().min(0.1).max(10).optional(),
})

/** Per-position TP/SL overrides — null clears the override back to global settings. */
const positionExitOverridesBody = z.object({
  takeProfitPct: z.number().min(0.1).max(50).nullable().optional(),
  stopLossPct: z.number().min(0.1).max(50).nullable().optional(),
  trailingStop: z.boolean().nullable().optional(),
})

const autopilotSettingsBody = z.object({
  enabled: z.boolean().optional(),
  maxBuyUsd: z.number().min(5).max(100).optional(),
  minLiquidityUsd: z.number().min(50_000).max(5_000_000).optional(),
  minSignal: z.enum(['rising', 'strong']).optional(),
  maxOpenPositions: z.number().int().min(1).max(3).optional(),
  recurringInterval: z.enum(['daily', 'weekly']).nullable().optional(),
  watchSymbol: z
    .union([
      z
        .string()
        .min(6)
        .max(32)
        .regex(/^[A-Z0-9]{2,28}USDT$/i)
        .transform((s) => s.toUpperCase()),
      z.null(),
    ])
    .optional(),
})

const limitOrderBody = z.object({
  binanceSymbol: z
    .string()
    .min(6)
    .max(32)
    .regex(/^[A-Z0-9]{2,28}USDT$/i)
    .transform((s) => s.toUpperCase()),
  side: z.enum(['BUY', 'SELL']),
  limitPrice: z.number().positive(),
  amount: z.number().positive(),
  spendMint: z.string().min(32).max(64).optional(),
})

const superMachineSettingsBody = z.object({
  enabled: z.boolean().optional(),
  maxTradeUsd: z.number().min(5).max(100).optional(),
  maxOpenPositions: z.number().int().min(1).max(5).optional(),
  maxDailyTrades: z.number().int().min(1).max(50).optional(),
  maxDailyVolumeUsd: z.number().min(20).max(5000).optional(),
  minLiquidityUsd: z.number().min(50_000).max(5_000_000).optional(),
  minSignal: z.enum(['rising', 'strong']).optional(),
  watchSymbol: z
    .union([
      z
        .string()
        .min(6)
        .max(32)
        .regex(/^[A-Z0-9]{2,28}USDT$/i)
        .transform((s) => s.toUpperCase()),
      z.null(),
    ])
    .optional(),
  emergencyStop: z.boolean().optional(),
})

const predictEventsQuery = z.object({
  category: z.enum(['all', 'crypto', 'sports', 'politics', 'esports', 'culture', 'economics', 'tech']).optional(),
  filter: z.enum(['new', 'live', 'trending']).optional(),
  limit: z.coerce.number().int().min(5).max(40).optional(),
  query: z.string().min(1).max(80).optional(),
  /** Stake used to work out contracts and payout on each market row. */
  stakeUsd: z.coerce.number().min(1).max(500).optional(),
})

const predictBuyBody = z.object({
  marketId: z.string().min(4).max(120),
  isYes: z.boolean(),
  amountUsd: z.number().min(1).max(500),
})

const predictClaimBody = z.object({
  positionPubkey: z.string().min(32).max(48),
})

const predictHistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

const sellOpenBody = z.object({
  binanceSymbol: z
    .string()
    .min(6)
    .max(32)
    .regex(/^[A-Z0-9]{2,28}USDT$/i)
    .transform((s) => s.toUpperCase()),
  fraction: z.enum(['all', 'half']).optional().default('all'),
})

router.get(
  '/meta',
  asyncHandler(async (_req: Request, res: Response) => {
    const registry = await getJupiterTradableRegistry()
    res.json({
      venue: 'Jupiter Ultra (Swap API v2)',
      chainId: 101,
      chainName: 'Solana',
      jupiterConfigured: isJupiterConfigured(),
      solanaWalletEnabled: isSolanaWalletEnabled(),
      minUsdcTrade: 1,
      defaultBuyUsd: 50,
      spendAssets: ['USDC', 'SOL'],
      catalogSymbols: registry.symbols.length > 0 ? registry.symbols : listSolCatalogBinanceSymbols(),
      tradableCount: registry.symbols.length,
      discovering: registry.discovering,
      priceSource: 'jupiter_v3',
      setupHint: isJupiterConfigured()
        ? null
        : 'Set JUPITER_API_KEY in server .env, then: docker compose up -d --build api',
      note: 'Live prices and charts from Jupiter Price API v3 on Solana. Swaps execute via Jupiter in USDC.',
    })
  }),
)

router.post(
  '/wallet/ensure',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    if (!isSolanaWalletEnabled()) {
      res.status(503).json({ error: 'WALLET_ENCRYPTION_KEY not configured' })
      return
    }
    const result = await ensureSolanaPersonalWallet(userId)
    res.json(result)
  }),
)

router.get(
  '/wallet/status',
  asyncHandler(async (req: Request, res: Response) => {
    const status = await getSolanaWalletStatus(req.user!.userId)
    res.json(status)
  }),
)

router.get(
  '/wallet/summary',
  asyncHandler(async (req: Request, res: Response) => {
    if (!isSolanaWalletEnabled()) {
      res.status(503).json({ error: 'WALLET_ENCRYPTION_KEY not configured' })
      return
    }
    try {
      await reconcileStaleJupiterOpenTrades(req.user!.userId).catch(() => 0)
      res.json(await getSolanaWalletDashboardSummary(req.user!.userId))
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Wallet summary failed'
      // Graceful fallback: return wallet status & last known value so frontend dashboard does not crash with 502
      const status = await getSolanaWalletStatus(req.user!.userId).catch(() => null)
      if (status?.wallet) {
        res.json({
          address: status.wallet.address,
          sol: 0,
          usdc: 0,
          totalUsd: Number((status.wallet as any).lastUsdValue ?? 0),
          tokens: [],
          supportedAssets: SOLANA_WITHDRAW_ASSETS,
          rpcDegraded: true,
          warning: msg,
        })
        return
      }
      res.status(502).json({ error: msg })
    }
  }),
)

router.get(
  '/wallet/balances',
  asyncHandler(async (req: Request, res: Response) => {
    if (!isSolanaWalletEnabled()) {
      res.status(503).json({ error: 'WALLET_ENCRYPTION_KEY not configured' })
      return
    }
    const status = await getSolanaWalletStatus(req.user!.userId)
    if (!status.wallet) {
      res.json({ address: null, sol: 0, usdc: 0, totalUsd: 0, supportedAssets: SOLANA_WITHDRAW_ASSETS })
      return
    }
    try {
      const balances = await getSolanaBalances(req.user!.userId)
      res.json({ address: status.wallet.address, ...balances, supportedAssets: SOLANA_WITHDRAW_ASSETS })
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Balance lookup failed' })
    }
  }),
)

// Every token the user actually holds — powers the "pay with any coin" picker.
router.get(
  '/wallet/tokens',
  asyncHandler(async (req: Request, res: Response) => {
    if (!isSolanaWalletEnabled()) {
      res.status(503).json({ error: 'WALLET_ENCRYPTION_KEY not configured' })
      return
    }
    const status = await getSolanaWalletStatus(req.user!.userId)
    if (!status.wallet) {
      res.json({ address: null, tokens: [] })
      return
    }
    try {
      const holdings = await listSolanaHoldings(req.user!.userId)
      // If token-account enumeration misses USDC (RPC blip), still list cash.
      const byMint = new Map(holdings.map((h) => [h.mint, h]))
      if (!byMint.has(SOL_USDC_MINT)) {
        const usdcAmt = await getSolanaTokenBalance(req.user!.userId, SOL_USDC_MINT, 6).catch(() => 0)
        if (usdcAmt > 0) {
          byMint.set(SOL_USDC_MINT, { mint: SOL_USDC_MINT, amount: usdcAmt, decimals: 6 })
        }
      }
      const merged = [...byMint.values()]
      const priceMap = await fetchJupiterPricesV3Batched(merged.map((h) => h.mint)).catch(
        () => new Map<string, { usdPrice?: number }>(),
      )
      const reg = await getJupiterTradableRegistry().catch(() => ({ tokens: [] }))
      const metaByMint = new Map<string, { symbol: string; icon: string | null }>()
      for (const t of reg.tokens) metaByMint.set(t.mint, { symbol: t.baseSymbol, icon: t.iconUrl ?? null })
      metaByMint.set(SOL_USDC_MINT, { symbol: 'USDC', icon: null })
      metaByMint.set(SOL_NATIVE_MINT, { symbol: 'SOL', icon: null })

      const tokens = merged.map((h) => {
        const usdPrice = h.mint === SOL_USDC_MINT ? 1 : priceMap.get(h.mint)?.usdPrice ?? 0
        const meta = metaByMint.get(h.mint)
        return {
          mint: h.mint,
          symbol: meta?.symbol ?? `${h.mint.slice(0, 4)}…${h.mint.slice(-4)}`,
          icon: meta?.icon ?? null,
          amount: h.amount,
          decimals: h.decimals,
          usdPrice,
          usdValue: usdPrice > 0 ? h.amount * usdPrice : 0,
        }
      })
      tokens.sort((a, b) => b.usdValue - a.usdValue)
      res.json({ address: status.wallet.address, tokens })
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Holdings lookup failed' })
    }
  }),
)

/**
 * Read-only holdings for any Solana address, so the trading screens can show a
 * connected browser wallet (Phantom, Solflare…) instead of the platform wallet.
 * Pricing and token metadata are resolved exactly as for the platform wallet.
 */
router.get(
  '/wallet/holdings-at/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const address = String(req.params.address ?? '').trim()
    let owner: PublicKey
    try {
      owner = new PublicKey(address)
    } catch {
      res.status(400).json({ error: 'Invalid Solana address' })
      return
    }

    try {
      const holdings = await listSolanaHoldingsForOwner(owner)
      const priceMap = await fetchJupiterPricesV3Batched(holdings.map((h) => h.mint)).catch(
        () => new Map<string, { usdPrice?: number }>(),
      )
      const reg = await getJupiterTradableRegistry().catch(() => ({ tokens: [] }))
      const metaByMint = new Map<string, { symbol: string; icon: string | null }>()
      for (const t of reg.tokens) metaByMint.set(t.mint, { symbol: t.baseSymbol, icon: t.iconUrl ?? null })
      metaByMint.set(SOL_USDC_MINT, { symbol: 'USDC', icon: null })
      metaByMint.set(SOL_NATIVE_MINT, { symbol: 'SOL', icon: null })

      const tokens = holdings.map((h) => {
        const usdPrice = h.mint === SOL_USDC_MINT ? 1 : (priceMap.get(h.mint)?.usdPrice ?? 0)
        const meta = metaByMint.get(h.mint)
        return {
          mint: h.mint,
          symbol: meta?.symbol ?? `${h.mint.slice(0, 4)}…${h.mint.slice(-4)}`,
          icon: meta?.icon ?? null,
          amount: h.amount,
          decimals: h.decimals,
          usdPrice,
          usdValue: usdPrice > 0 ? h.amount * usdPrice : 0,
        }
      })
      tokens.sort((a, b) => b.usdValue - a.usdValue)

      const sol = holdings.find((h) => h.mint === SOL_NATIVE_MINT)?.amount ?? 0
      const usdc = holdings.find((h) => h.mint === SOL_USDC_MINT)?.amount ?? 0

      res.json({
        address: owner.toBase58(),
        sol,
        usdc,
        totalUsd: tokens.reduce((acc, t) => acc + t.usdValue, 0),
        tokens,
      })
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Holdings lookup failed' })
    }
  }),
)

const withdrawBody = z.object({
  asset: z.enum(['USDC', 'SOL']),
  amount: z.number().positive().max(1_000_000),
  toAddress: z.string().min(32).max(64),
})

router.post(
  '/wallet/withdraw',
  delegateSwapLimiter,
  validate(withdrawBody),
  asyncHandler(async (req: Request, res: Response) => {
    if (!isSolanaWalletEnabled()) {
      res.status(503).json({ error: 'WALLET_ENCRYPTION_KEY not configured' })
      return
    }
    const body = (req as Request & { validated: z.infer<typeof withdrawBody> }).validated
    try {
      const result = await withdrawFromSolanaWallet(req.user!.userId, body)
      res.json(result)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Withdrawal failed' })
    }
  }),
)

router.get(
  '/wallet/withdrawals',
  asyncHandler(async (req: Request, res: Response) => {
    const items = await listSolanaWithdrawals(req.user!.userId, 25)
    res.json({
      items: items.map((item) => ({
        id: item.id,
        asset: item.asset,
        amount: Number(item.amount),
        toAddress: item.toAddress,
        txSignature: item.txSignature,
        status: item.status,
        errorMessage: item.errorMessage,
        requestedAt: item.requestedAt.toISOString(),
        processedAt: item.processedAt?.toISOString() ?? null,
      })),
    })
  }),
)

router.get(
  '/wallet/token-balance/:binanceSymbol',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const binanceSymbol = String(req.params.binanceSymbol ?? '').toUpperCase()
    if (!isValidBinanceUsdtSymbol(binanceSymbol)) {
      res.status(400).json({ error: 'Invalid Binance symbol' })
      return
    }
    const token = await getJupiterTradableToken(binanceSymbol)
    if (!token) {
      res.json({ binanceSymbol, balance: 0, token: null })
      return
    }
    const balance = await getSolanaTokenBalance(userId, token.mint, token.decimals)
    res.json({ binanceSymbol, balance, token: { baseSymbol: token.baseSymbol, mint: token.mint, decimals: token.decimals } })
  }),
)

router.get(
  '/market-board',
  validate(marketBoardQuery),
  asyncHandler(async (req: Request, res: Response) => {
    const q = (req as Request & { validated?: { limit?: number } }).validated ?? {}
    const limit = q.limit ?? 1500
    if (!isJupiterConfigured()) {
      res.status(503).json({ error: 'Jupiter API key not configured on server' })
      return
    }
    try {
      const board = await getJupiterLiveMarketBoard(limit)
      res.json(board)
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Jupiter market board unavailable' })
    }
  }),
)

router.get(
  '/candles/:binanceSymbol',
  validate(candlesQuery),
  asyncHandler(async (req: Request, res: Response) => {
    const binanceSymbol = String(req.params.binanceSymbol ?? '').toUpperCase()
    if (!isValidBinanceUsdtSymbol(binanceSymbol)) {
      res.status(400).json({ error: 'Invalid Binance symbol' })
      return
    }
    if (!isJupiterConfigured()) {
      res.status(503).json({ error: 'Jupiter API key not configured on server' })
      return
    }
    const q = (req as Request & { validated?: z.infer<typeof candlesQuery> }).validated ?? {}
    try {
      const result = await getJupiterAlignedCandles(binanceSymbol, q.interval ?? '15m', q.limit ?? 72)
      res.json(result)
    } catch (err) {
      // Only non-tradable tokens or invalid intervals reach here now — candle
      // source failures degrade gracefully inside the service.
      res.status(422).json({ error: err instanceof Error ? err.message : 'Jupiter candles unavailable' })
    }
  }),
)

router.get(
  '/price/:binanceSymbol',
  asyncHandler(async (req: Request, res: Response) => {
    const binanceSymbol = String(req.params.binanceSymbol ?? '').toUpperCase()
    if (!isValidBinanceUsdtSymbol(binanceSymbol)) {
      res.status(400).json({ error: 'Invalid Binance symbol' })
      return
    }
    try {
      res.json(await getJupiterLivePrice(binanceSymbol))
    } catch (err) {
      res.status(422).json({ error: err instanceof Error ? err.message : 'Price unavailable' })
    }
  }),
)

router.get(
  '/marks/:binanceSymbol',
  asyncHandler(async (req: Request, res: Response) => {
    const binanceSymbol = String(req.params.binanceSymbol ?? '').toUpperCase()
    if (!isValidBinanceUsdtSymbol(binanceSymbol)) {
      res.status(400).json({ error: 'Invalid symbol' })
      return
    }
    if (!isJupiterConfigured()) {
      res.status(503).json({ error: 'Jupiter API key not configured on server' })
      return
    }
    const marks = await getJupiterExecutableMarks(binanceSymbol)
    if (!marks) {
      res.status(422).json({ error: 'Could not fetch Jupiter marks for this token' })
      return
    }
    res.json({ ...marks, updatedAt: new Date(marks.ts).toISOString() })
  }),
)

router.get(
  '/depth/:binanceSymbol',
  asyncHandler(async (req: Request, res: Response) => {
    const binanceSymbol = String(req.params.binanceSymbol ?? '').toUpperCase()
    if (!isValidBinanceUsdtSymbol(binanceSymbol)) {
      res.status(400).json({ error: 'Invalid symbol' })
      return
    }
    if (!isJupiterConfigured()) {
      res.status(503).json({ error: 'Jupiter API key not configured on server' })
      return
    }
    const levels = Math.min(16, Math.max(4, Number.parseInt(String(req.query.levels ?? '12'), 10) || 12))
    res.json(await getJupiterSyntheticDepth(binanceSymbol, levels))
  }),
)

router.get(
  '/overview',
  validate(marketBoardQuery),
  asyncHandler(async (req: Request, res: Response) => {
    const q = (req as Request & { validated?: { limit?: number } }).validated ?? {}
    const limit = q.limit ?? 1500
    const board = await getJupiterLiveMarketBoard(limit)
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
    const token = await getJupiterTradableToken(binanceSymbol)
    res.json({
      binanceSymbol,
      tradable: Boolean(token),
      token,
      message: token
        ? undefined
        : 'This Binance pair has no Solana mint in our catalog. Trade majors from the Solana list.',
    })
  }),
)

router.get(
  '/positions',
  asyncHandler(async (req: Request, res: Response) => {
    if (!isJupiterConfigured()) {
      res.status(503).json({ error: 'Jupiter API key not configured on server' })
      return
    }
    try {
      const userId = req.user!.userId
      const cached = positionsCache.get(userId)
      if (cached && Date.now() - cached.at < POSITIONS_CACHE_MS) {
        res.json(cached.payload)
        return
      }
      const positions = await getJupiterOpenPositions(userId)
      const totalNetPnlUsd = positions.reduce((sum, p) => sum + (p.estNetPnlUsd ?? 0), 0)
      const totalValueUsd = positions.reduce((sum, p) => sum + (p.currentValueUsd ?? 0), 0)
      const totalBankedSkimUsd = positions.reduce((sum, p) => sum + (p.bankedSkimUsd ?? 0), 0)
      const payload = {
        positions,
        totalNetPnlUsd: Math.round(totalNetPnlUsd * 1e2) / 1e2,
        totalValueUsd: Math.round(totalValueUsd * 1e2) / 1e2,
        totalBankedSkimUsd: Math.round(totalBankedSkimUsd * 1e4) / 1e4,
        updatedAt: new Date().toISOString(),
      }
      positionsCache.set(userId, { at: Date.now(), payload })
      res.json(payload)
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Positions unavailable' })
    }
  }),
)

router.get(
  '/suggestions',
  asyncHandler(async (_req: Request, res: Response) => {
    if (!isJupiterConfigured()) {
      res.status(503).json({ error: 'Jupiter API key not configured on server' })
      return
    }
    try {
      const result = await getJupiterTradeSuggestions(8)
      res.json(result)
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Suggestions unavailable' })
    }
  }),
)

router.get(
  '/quote',
  validate(quoteQuery),
  asyncHandler(async (req: Request, res: Response) => {
    const v = (req as Request & { validated: z.infer<typeof quoteQuery> }).validated
    if (!isJupiterConfigured()) {
      res.status(503).json({ error: 'Jupiter API key not configured on server' })
      return
    }
    try {
      const cacheKey = `${req.user!.userId}|${v.binanceSymbol}|${v.side}|${v.amount}|${v.slippageBps ?? ''}|${v.spendMint ?? v.spendAsset ?? ''}`
      const hit = quotePreviewCache.get(cacheKey)
      if (hit && Date.now() - hit.at < QUOTE_PREVIEW_CACHE_MS) {
        res.json(hit.body)
        return
      }
      const preview = await previewJupiterSwap(
        {
          side: v.side,
          binanceSymbol: v.binanceSymbol,
          amount: v.amount,
          slippageBps: v.slippageBps,
          spendAsset: v.spendAsset,
          spendMint: v.spendMint,
        },
        { userId: req.user!.userId },
      )
      quotePreviewCache.set(cacheKey, { at: Date.now(), body: preview })
      res.json(preview)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not fetch a Jupiter quote right now.'
      if (/too many requests|rate limit|429|api gateway|jupiter is busy/i.test(msg)) {
        const cacheKey = `${req.user!.userId}|${v.binanceSymbol}|${v.side}|${v.amount}|${v.slippageBps ?? ''}|${v.spendMint ?? v.spendAsset ?? ''}`
        const hit = quotePreviewCache.get(cacheKey)
        if (hit && Date.now() - hit.at < QUOTE_PREVIEW_STALE_MS) {
          res.json(hit.body)
          return
        }
      }
      // Surface a readable reason instead of a generic 500 so the UI can show it.
      res.status(400).json({ error: msg })
    }
  }),
)

router.post(
  '/swap',
  delegateSwapLimiter,
  validate(swapBody),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const body = (req as Request & { validated: z.infer<typeof swapBody> }).validated
    if (!isJupiterConfigured()) {
      res.status(503).json({ error: 'Jupiter API key not configured on server' })
      return
    }
    try {
      const result = await executeJupiterSwap(
        userId,
        body,
        {
          skipEntryGuard: body.skipEntryGuard,
          smartRoute: body.smartRoute !== false,
        },
      )
      positionsCache.delete(userId)
      quotePreviewCache.clear()
      const io = getSocketIo()
      io?.to(`user:${userId}`).emit('trade:executed', {
        source: 'dex-jupiter',
        ...result,
      })
      res.json(result)
    } catch (err) {
      // Business/route errors (insufficient balance, min size, blocked trade,
      // no route, Jupiter hiccup) must reach the user as a clear message rather
      // than a generic 500 "Internal server error".
      const message = err instanceof Error ? err.message : 'Swap failed — please try again.'
      res.status(400).json({ error: message })
    }
  }),
)

// ─── Manual trading desk (works for platform and connected wallets) ───

const deskQuery = z.object({
  binanceSymbol: z
    .string()
    .min(6)
    .max(32)
    .regex(/^[A-Z0-9]{2,28}USDT$/i)
    .transform((s) => s.toUpperCase()),
  /** Connected wallet address; omit to report on the platform wallet. */
  owner: z.string().min(32).max(48).optional(),
  probeUsd: z.coerce.number().positive().max(500).optional(),
})

router.get(
  '/desk',
  validate(deskQuery),
  asyncHandler(async (req: Request, res: Response) => {
    const q = (req as Request & { validated: z.infer<typeof deskQuery> }).validated
    try {
      res.json(await getJupiterDesk({ userId: req.user!.userId, ...q }))
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Desk unavailable' })
    }
  }),
)

const manualPreflightBody = z.object({
  binanceSymbol: z
    .string()
    .min(6)
    .max(32)
    .regex(/^[A-Z0-9]{2,28}USDT$/i)
    .transform((s) => s.toUpperCase()),
  side: z.enum(['BUY', 'SELL']),
  amount: z.number().positive().max(1_000_000),
  slippageBps: z.number().int().min(10).max(2000).optional(),
  spendMint: z.string().min(32).max(48).optional(),
  owner: z.string().min(32).max(48).optional(),
})

router.post(
  '/manual/preflight',
  validate(manualPreflightBody),
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req as Request & { validated: z.infer<typeof manualPreflightBody> }).validated
    try {
      res.json(await previewJupiterManualTrade({ userId: req.user!.userId, ...body }))
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Preflight failed' })
    }
  }),
)

// ─── Self-custody swaps (signed by the user's browser wallet) ─────────

const browserBuildBody = z.object({
  owner: z.string().min(32).max(48),
  side: z.enum(['BUY', 'SELL']),
  binanceSymbol: z
    .string()
    .min(6)
    .max(32)
    .regex(/^[A-Z0-9]{2,28}USDT$/i)
    .transform((s) => s.toUpperCase()),
  amount: z.number().positive().max(1_000_000),
  slippageBps: z.number().int().min(10).max(2000).optional(),
  spendMint: z.string().min(32).max(48).optional(),
})

/** Returns an unsigned transaction for the connected wallet to sign. */
router.post(
  '/browser/build-swap',
  delegateSwapLimiter,
  validate(browserBuildBody),
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req as Request & { validated: z.infer<typeof browserBuildBody> }).validated
    try {
      res.json(await buildBrowserJupiterSwap({ userId: req.user!.userId, ...body }))
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Could not build swap' })
    }
  }),
)

const browserSubmitBody = z.object({
  requestId: z.string().min(4).max(200),
  signedTransaction: z.string().min(32).max(20_000),
})

/** Relays the wallet-signed transaction to Jupiter and books the fill. */
router.post(
  '/browser/submit-swap',
  delegateSwapLimiter,
  validate(browserSubmitBody),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const body = (req as Request & { validated: z.infer<typeof browserSubmitBody> }).validated
    try {
      const result = await submitBrowserJupiterSwap({ userId, ...body })
      getSocketIo()?.to(`user:${userId}`).emit('trade:executed', {
        source: 'dex-jupiter-self-custody',
        ...result,
      })
      res.json(result)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Swap submission failed' })
    }
  }),
)

/** Open self-custody lots — shown with exit alerts, never auto-sold. */
router.get(
  '/browser/positions',
  asyncHandler(async (req: Request, res: Response) => {
    const owner = typeof req.query.owner === 'string' ? req.query.owner : undefined
    const { positions, thresholds } = await listSelfCustodyPositions(req.user!.userId, owner)
    res.json({
      positions,
      thresholds,
      autoManaged: false,
      note: 'The bot holds no key for these positions, so take-profit and stop-loss are alerts you action yourself.',
    })
  }),
)

const executionCompareQuery = z.object({
  side: z.enum(['BUY', 'SELL']),
  binanceSymbol: z
    .string()
    .min(6)
    .max(32)
    .regex(/^[A-Z0-9]{2,28}USDT$/i)
    .transform((s) => s.toUpperCase()),
  amount: z.coerce.number().positive().max(1_000_000),
  slippageBps: z.coerce.number().int().min(10).max(2000).optional(),
  spendMint: z.string().min(32).max(48).optional(),
  includeSecondary: z
    .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
})

router.get(
  '/execution/compare',
  validate(executionCompareQuery),
  asyncHandler(async (req: Request, res: Response) => {
    if (!isJupiterConfigured()) {
      res.status(503).json({ error: 'Jupiter API key not configured on server' })
      return
    }
    const v = (req as Request & { validated: z.infer<typeof executionCompareQuery> }).validated
    try {
      const result = await compareExecutionRoutes({
        side: v.side,
        binanceSymbol: v.binanceSymbol,
        amount: v.amount,
        spendMint: v.spendMint,
        slippageBps: v.slippageBps,
        includeSecondary: v.includeSecondary,
      })
      res.json(result)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Compare failed' })
    }
  }),
)

router.get(
  '/journal',
  asyncHandler(async (req: Request, res: Response) => {
    const journal = await getJupiterTradeJournal(req.user!.userId)
    res.json(journal)
  }),
)

router.get(
  '/exit-settings',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(getJupiterExitSettings(req.user!.userId))
  }),
)

router.put(
  '/exit-settings',
  validate(exitSettingsBody),
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req as Request & { validated: z.infer<typeof exitSettingsBody> }).validated
    const saved = setJupiterExitSettings(req.user!.userId, body)
    res.json(saved)
  }),
)

router.get(
  '/autopilot-settings',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(getJupiterAutopilotSettings(req.user!.userId))
  }),
)

router.put(
  '/autopilot-settings',
  validate(autopilotSettingsBody),
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req as Request & { validated: z.infer<typeof autopilotSettingsBody> }).validated
    const saved = setJupiterAutopilotSettings(req.user!.userId, body)
    res.json(saved)
  }),
)

router.get(
  '/limit-orders',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ orders: getJupiterLimitOrders(req.user!.userId) })
  }),
)

router.post(
  '/limit-orders',
  validate(limitOrderBody),
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req as Request & { validated: z.infer<typeof limitOrderBody> }).validated
    const order = createJupiterLimitOrder(req.user!.userId, body)
    res.status(201).json(order)
  }),
)

router.delete(
  '/limit-orders/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id ?? '')
    const ok = cancelJupiterLimitOrder(req.user!.userId, id)
    if (!ok) {
      res.status(404).json({ error: 'Limit order not found or already closed' })
      return
    }
    res.json({ ok: true })
  }),
)

router.get(
  '/super-machine/settings',
  asyncHandler(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(await getSuperMachineSettings(req.user!.userId))
  }),
)

router.put(
  '/super-machine/settings',
  validate(superMachineSettingsBody),
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req as Request & { validated: z.infer<typeof superMachineSettingsBody> }).validated
    const saved = await setSuperMachineSettings(req.user!.userId, body)
    res.json(saved)
  }),
)

router.get(
  '/super-machine/status',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await getSuperMachineStatus(req.user!.userId))
  }),
)

router.get(
  '/council/status',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await getCouncilStatus(req.user!.userId))
  }),
)

router.get(
  '/council/decisions',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200))
    res.json({ decisions: await getCouncilDecisionHistory(req.user!.userId, limit) })
  }),
)

router.get(
  '/signals',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 8))
    res.json(await getJupiterTradeSignals(limit))
  }),
)

router.get(
  '/predictions/events',
  validate(predictEventsQuery),
  asyncHandler(async (req: Request, res: Response) => {
    if (!isJupiterConfigured()) {
      res.status(503).json({ error: 'Jupiter API key not configured on server' })
      return
    }
    const v = (req as Request & { validated: z.infer<typeof predictEventsQuery> }).validated
    try {
      if (v.query?.trim()) {
        const { events } = await searchJupiterPredictionEvents(v.query.trim(), v.limit ?? 12)
        res.json({
          events,
          insights: await buildEventInsights(events, v.stakeUsd),
          updatedAt: new Date().toISOString(),
          beta: true,
        })
        return
      }
      const result = await listJupiterPredictionEvents({
        category: v.category ?? 'crypto',
        filter: v.filter,
        limit: v.limit ?? 20,
      })
      res.json({
        ...result,
        insights: await buildEventInsights(result.events, v.stakeUsd),
        beta: true,
      })
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Could not load events.' })
    }
  }),
)

router.get(
  '/predictions/positions',
  asyncHandler(async (req: Request, res: Response) => {
    if (!isJupiterConfigured()) {
      res.status(503).json({ error: 'Jupiter API key not configured on server' })
      return
    }
    try {
      const result = await getJupiterPredictionPositions(req.user!.userId)
      res.json({ ...result, updatedAt: new Date().toISOString() })
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Could not load positions.' })
    }
  }),
)

router.post(
  '/predictions/buy',
  delegateSwapLimiter,
  validate(predictBuyBody),
  asyncHandler(async (req: Request, res: Response) => {
    if (!isJupiterConfigured()) {
      res.status(503).json({ error: 'Jupiter API key not configured on server' })
      return
    }
    const body = (req as Request & { validated: z.infer<typeof predictBuyBody> }).validated
    try {
      const result = await buyJupiterPrediction(req.user!.userId, body)
      res.json(result)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Prediction buy failed' })
    }
  }),
)

router.post(
  '/predictions/claim',
  delegateSwapLimiter,
  validate(predictClaimBody),
  asyncHandler(async (req: Request, res: Response) => {
    if (!isJupiterConfigured()) {
      res.status(503).json({ error: 'Jupiter API key not configured on server' })
      return
    }
    const body = (req as Request & { validated: z.infer<typeof predictClaimBody> }).validated
    try {
      const result = await claimJupiterPredictionPosition(req.user!.userId, body.positionPubkey)
      res.json(result)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Claim failed' })
    }
  }),
)

router.post(
  '/predictions/close',
  delegateSwapLimiter,
  validate(predictClaimBody),
  asyncHandler(async (req: Request, res: Response) => {
    if (!isJupiterConfigured()) {
      res.status(503).json({ error: 'Jupiter API key not configured on server' })
      return
    }
    const body = (req as Request & { validated: z.infer<typeof predictClaimBody> }).validated
    try {
      const result = await closeJupiterPredictionPosition(req.user!.userId, body.positionPubkey)
      res.json(result)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Close/sell failed' })
    }
  }),
)

router.get(
  '/predictions/history',
  validate(predictHistoryQuery),
  asyncHandler(async (req: Request, res: Response) => {
    const v = (req as Request & { validated: z.infer<typeof predictHistoryQuery> }).validated
    try {
      const result = await getJupiterPredictionHistory(req.user!.userId, v.limit ?? 50)
      res.json(result)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Could not load history.' })
    }
  }),
)

router.post(
  '/sell-open',
  delegateSwapLimiter,
  validate(sellOpenBody),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const body = (req as Request & { validated: z.infer<typeof sellOpenBody> }).validated
    if (!isJupiterConfigured()) {
      res.status(503).json({ error: 'Jupiter API key not configured on server' })
      return
    }
    try {
      const result = await sellJupiterOpenPosition(userId, body.binanceSymbol, body.fraction)
      if ('clearedStale' in result && result.clearedStale) {
        const io = getSocketIo()
        io?.to(`user:${userId}`).emit('trade:executed', {
          source: 'dex-jupiter-sell-open-stale-clear',
          ...result,
        })
        res.json(result)
        return
      }
      const io = getSocketIo()
      io?.to(`user:${userId}`).emit('trade:executed', {
        source: 'dex-jupiter-sell-open',
        ...result,
      })
      res.json(result)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Sell failed' })
    }
  }),
)

// ---- Per-position exit management -------------------------------------------

/** Update TP/SL/trailing on a RUNNING position — the watcher picks it up next tick. */
router.put(
  '/positions/:binanceSymbol/exit-overrides',
  validate(positionExitOverridesBody),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const binanceSymbol = String(req.params.binanceSymbol ?? '').toUpperCase()
    if (!isValidBinanceUsdtSymbol(binanceSymbol)) {
      res.status(400).json({ error: 'Invalid symbol' })
      return
    }
    const body = (req as Request & { validated: z.infer<typeof positionExitOverridesBody> }).validated
    const result = await setJupiterPositionExitOverrides(userId, binanceSymbol, body)
    if (result.updated === 0) {
      res.status(404).json({ error: `No open ${binanceSymbol} position to update` })
      return
    }
    positionsCache.delete(userId)
    const io = getSocketIo()
    io?.to(`user:${userId}`).emit('positions:refresh', { source: 'exit-overrides', binanceSymbol })
    res.json(result)
  }),
)

/** Manual profit skim — banks the profit slice into USDC, position keeps running. */
router.post(
  '/positions/:binanceSymbol/skim',
  delegateSwapLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const binanceSymbol = String(req.params.binanceSymbol ?? '').toUpperCase()
    if (!isValidBinanceUsdtSymbol(binanceSymbol)) {
      res.status(400).json({ error: 'Invalid symbol' })
      return
    }
    if (!isJupiterConfigured()) {
      res.status(503).json({ error: 'Jupiter API key not configured on server' })
      return
    }
    try {
      const result = await skimJupiterPositionProfit(userId, binanceSymbol)
      positionsCache.delete(userId)
      const io = getSocketIo()
      io?.to(`user:${userId}`).emit('trade:executed', {
        source: 'dex-jupiter-manual-skim',
        reason: 'profit_skim',
        ...result,
        trade: {
          ...result.trade,
          signal: 'SELL',
          pair: result.trade.pair,
          price: result.trade.exitPrice ?? result.trade.entryPrice,
        },
      })
      void telegramService
        .notifyDexBotTrade({
          userId,
          action: 'SELL',
          pair: result.trade.pair,
          reason: 'Jupiter manual profit skim (position still open)',
          fillPriceUsd: result.trade.exitPrice ?? undefined,
          entryPriceUsd: result.trade.entryPrice,
          realizedPnlUsd: result.trade.pnl,
          txHash: result.txSignature,
          trigger: 'manual',
          walletLabel: 'Jupiter Super Machine',
        })
        .catch(() => null)
      res.json(result)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Skim failed' })
    }
  }),
)

// ---- Convert (Binance-style same-chain swap of held coins) -----------------
const convertQuoteQuery = z.object({
  fromMint: z.string().min(32).max(48),
  toMint: z.string().min(32).max(48),
  amount: z.coerce.number().positive().max(1_000_000),
  slippageBps: z.coerce.number().int().min(10).max(2000).optional(),
})

const convertBody = z.object({
  fromMint: z.string().min(32).max(48),
  toMint: z.string().min(32).max(48),
  amount: z.number().positive().max(1_000_000),
  slippageBps: z.number().int().min(10).max(2000).optional(),
})

router.get(
  '/convert/quote',
  validate(convertQuoteQuery),
  asyncHandler(async (req: Request, res: Response) => {
    if (!isJupiterConfigured()) {
      res.status(503).json({ error: 'Jupiter API key not configured on server' })
      return
    }
    const v = (req as Request & { validated: z.infer<typeof convertQuoteQuery> }).validated
    try {
      const preview = await previewSolanaConvert(v)
      res.json(preview)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Could not quote this conversion.' })
    }
  }),
)

router.post(
  '/convert',
  delegateSwapLimiter,
  validate(convertBody),
  asyncHandler(async (req: Request, res: Response) => {
    if (!isJupiterConfigured()) {
      res.status(503).json({ error: 'Jupiter API key not configured on server' })
      return
    }
    if (!isSolanaWalletEnabled()) {
      res.status(503).json({ error: 'WALLET_ENCRYPTION_KEY not configured' })
      return
    }
    const userId = req.user!.userId
    const body = (req as Request & { validated: z.infer<typeof convertBody> }).validated
    try {
      const result = await convertSolanaTokens(userId, body)
      res.json(result)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Convert failed — please try again.' })
    }
  }),
)

export default router
