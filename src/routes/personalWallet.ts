import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma, TradeStatus } from '@cryptoflow/db'
import { authenticateToken } from '../middleware/authenticateToken'
import { asyncHandler } from '../middleware/asyncHandler'
import { validate } from '../middleware/validate'
import {
  ensurePersonalWallet,
  executePersonalSwap,
  getDexAllocationSuggestions,
  getPersonalWalletSummary,
  isPersonalWalletEnabled,
  listWithdrawals,
  PERSONAL_WALLET_TOKENS,
  previewBscConvert,
  convertBscTokens,
  listBscConvertCatalog,
  sellAggregatedOpenPosition,
  withdrawFromPersonalWallet,
} from '../services/wallet/personalWalletService'
import { telegramService } from '../services/notifications/telegramService'
import { getSocketIo } from '../lib/realtimeHub'
import { sellOneInchOpenPosition } from '../services/dex/oneInchSwapService'
import { sellJupiterOpenPosition } from '../services/dex/jupiterSwapService'
import { sellBinanceOpenPosition } from '../services/trading/binanceSpotTradeService'
import { ONEINCH_STRATEGY_NAME, JUPITER_STRATEGY_NAME } from '../services/portfolio/equityService'
import { CEX_BINANCE_STRATEGY_NAME } from '../services/trading/binanceSpotQuoteService'
import {
  CROSS_CHAIN_DIRECTIONS,
  executeCrossChainTransfer,
  getCrossChainQuote,
  getCrossChainStatusPayload,
  isCrossChainTransferEnabled,
  listCrossChainSourceAssets,
  listCrossChainTransfers,
  previewCrossChainTransfer,
  type CrossChainDirection,
} from '../services/wallet/crossChainTransferService'
import { retryAllPendingCrossChainCredits, retryCrossChainCredit } from '../services/wallet/crossChainCreditRetryService'
import { listWalletActivity, type WalletActivityScope } from '../services/wallet/walletActivityService'

const router = Router()

const withdrawSchema = z.object({
  asset: z.string().min(1),
  amount: z.number().positive().max(1_000_000),
  /** Paste from any BSC-compatible exchange; optional 0x, extra spaces OK. */
  toAddress: z.string().min(1).max(200),
})

const swapSchema = z.object({
  side: z.enum(['BUY', 'SELL']),
  tokenSymbol: z.string().min(1),
  amount: z.number().positive().max(1_000_000),
  slippageBps: z.number().int().min(10).max(2000).optional(),
})

const sellOpenSchema = z.object({
  symbol: z.string().min(1).max(16),
})

const crossChainTransferSchema = z.object({
  direction: z.enum(CROSS_CHAIN_DIRECTIONS),
  amount: z.number().positive().max(1_000_000),
  sourceSymbol: z.string().min(1).max(16).optional(),
  destSymbol: z.string().min(1).max(16).optional(),
})

const bscConvertQuoteQuery = z.object({
  fromSymbol: z.string().min(1).max(16),
  toSymbol: z.string().min(1).max(16),
  amount: z.coerce.number().positive().max(1_000_000),
})

const bscConvertBody = z.object({
  fromSymbol: z.string().min(1).max(16),
  toSymbol: z.string().min(1).max(16),
  amount: z.number().positive().max(1_000_000),
  slippageBps: z.number().int().min(10).max(2000).optional(),
})

router.use(authenticateToken)

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    if (!isPersonalWalletEnabled()) {
      res.json({
        configured: false,
        wallet: null,
        message:
          'Personal wallets are not enabled on this server. Set WALLET_ENCRYPTION_KEY in the API environment.',
      })
      return
    }

    const existing = await prisma.personalWallet.findUnique({ where: { userId } })
    if (!existing) {
      res.json({
        configured: true,
        wallet: null,
        supportedAssets: PERSONAL_WALLET_TOKENS.map((t) => t.symbol),
      })
      return
    }
    const summary = await getPersonalWalletSummary(userId)
    res.json({
      configured: true,
      wallet: summary,
      supportedAssets: PERSONAL_WALLET_TOKENS.map((t) => t.symbol),
    })
  }),
)

router.post(
  '/create',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    if (!isPersonalWalletEnabled()) {
      res.status(503).json({
        error: 'Personal wallets are not enabled on this server.',
      })
      return
    }
    const { address, created } = await ensurePersonalWallet(userId)
    res.status(created ? 201 : 200).json({ address, created })
  }),
)

router.post(
  '/withdraw',
  validate(withdrawSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const { asset, amount, toAddress } = (req as Request & {
      validated: { asset: string; amount: number; toAddress: string }
    }).validated
    try {
      const result = await withdrawFromPersonalWallet(userId, { asset, amount, toAddress })
      res.json(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Withdrawal failed'
      res.status(400).json({ error: message })
    }
  }),
)

router.post(
  '/swap',
  validate(swapSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const payload = (req as Request & {
      validated: { side: 'BUY' | 'SELL'; tokenSymbol: string; amount: number; slippageBps?: number }
    }).validated
    try {
      const result = await executePersonalSwap(userId, payload)
      const closedRoundTrip = result.trade.side === 'CLOSED'
      const sellFill =
        result.side === 'SELL' && result.trade.exitPrice != null
          ? result.trade.exitPrice
          : result.trade.entryPrice
      void telegramService
        .notifyDexBotTrade({
          userId,
          action: result.side,
          pair: result.trade.pair,
          reason:
            result.side === 'BUY'
              ? 'Position opened'
              : closedRoundTrip
                ? 'Round-trip closed'
                : 'Sell executed',
          fillPriceUsd: sellFill,
          entryPriceUsd: result.side === 'SELL' ? result.trade.entryPrice : undefined,
          usdtSpent:
            result.side === 'BUY' || closedRoundTrip ? result.trade.allocationUsd : undefined,
          usdtReceived: result.side === 'SELL' ? parseFloat(result.expectedOut) : undefined,
          realizedPnlUsd: closedRoundTrip ? result.trade.pnl : null,
          txHash: result.txHash,
          trigger: 'manual',
        })
        .catch(() => null)

      const io = getSocketIo()
      if (io) {
        io.to(`user:${userId}`).emit('trade:executed', {
          trade: {
            id: result.trade.id,
            pair: result.trade.pair,
            signal: result.side,
            price: result.trade.entryPrice,
            entryPrice: result.trade.entryPrice,
            pnl: result.trade.pnl,
            status: 'CLOSED',
          },
          currentPnl: result.trade.pnl,
        })
      }

      res.json(result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Swap failed'
      void telegramService
        .notifyTradeFailed({
          userId,
          symbol: payload.tokenSymbol,
          side: payload.side,
          errorType: 'personal_wallet_swap',
          message: msg.slice(0, 1500),
        })
        .catch(() => null)
      res.status(400).json({ error: msg })
    }
  }),
)

router.post(
  '/sell-open',
  validate(sellOpenSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const { symbol } = (req as Request & { validated: { symbol: string } }).validated
    const sym = symbol.toUpperCase()
    const pair = `${sym}/USDT`
    try {
      const openCex = await prisma.trade.findFirst({
        where: {
          userId,
          pair,
          status: TradeStatus.OPEN,
          strategy: { name: CEX_BINANCE_STRATEGY_NAME },
        },
        select: { id: true },
      })
      const oneInchOpen = openCex
        ? null
        : await prisma.trade.findFirst({
            where: {
              userId,
              pair,
              status: TradeStatus.OPEN,
              strategy: { name: ONEINCH_STRATEGY_NAME },
            },
            select: { id: true },
          })
      const jupiterOpen =
        openCex || oneInchOpen
          ? null
          : await prisma.trade.findFirst({
              where: {
                userId,
                pair,
                status: TradeStatus.OPEN,
                strategy: { name: JUPITER_STRATEGY_NAME },
              },
              select: { id: true },
            })
      const result = openCex
        ? await sellBinanceOpenPosition(userId, sym)
        : oneInchOpen
          ? await sellOneInchOpenPosition(userId, sym)
          : jupiterOpen
            ? await sellJupiterOpenPosition(userId, sym)
            : await sellAggregatedOpenPosition(userId, sym)
      if ('clearedStale' in result && result.clearedStale === true) {
        const io = getSocketIo()
        io?.to(`user:${userId}`).emit('trade:executed', {
          source: 'sell-open-stale-clear',
          ...result,
        })
        res.json(result)
        return
      }
      // Narrow away Jupiter stale-clear union arm for the fill path below.
      const fill = result as Exclude<typeof result, { clearedStale: true }>
      const closedRoundTrip = fill.trade.side === 'CLOSED'
      const isCex = Boolean(openCex)
      const isJupiter = Boolean(jupiterOpen)
      void telegramService
        .notifyDexBotTrade({
          userId,
          action: 'SELL',
          pair: fill.trade.pair,
          reason: isCex ? 'Manual sell (Binance Spot)' : 'Manual sell from dashboard',
          fillPriceUsd: fill.trade.exitPrice ?? fill.trade.entryPrice,
          entryPriceUsd: fill.trade.entryPrice,
          usdtReceived: isCex
            ? (fill.trade.exitPrice != null && fill.trade.allocationUsd
                ? fill.trade.allocationUsd
                : undefined)
            : parseFloat((fill as { expectedOut?: string }).expectedOut ?? '0'),
          realizedPnlUsd: closedRoundTrip ? fill.trade.pnl : null,
          txHash: isCex
            ? undefined
            : (fill as { txHash?: string; txSignature?: string }).txHash ??
              (fill as { txSignature?: string }).txSignature,
          trigger: 'manual',
        })
        .catch(() => null)

      const io = getSocketIo()
      if (io) {
        io.to(`user:${userId}`).emit('trade:executed', {
          trade: {
            id: fill.trade.id,
            pair: fill.trade.pair,
            signal: 'SELL',
            entryPrice: fill.trade.entryPrice,
            exitPrice: fill.trade.exitPrice,
            pnl: fill.trade.pnl,
            status: fill.trade.status,
            side: fill.trade.side,
          },
          currentPnl: fill.trade.pnl ?? 0,
        })
      }
      res.json(
        isCex
          ? { venue: 'binance', orderId: (fill as { orderId: string }).orderId, trade: fill.trade }
          : fill,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sell failed'
      res.status(400).json({ error: msg })
    }
  }),
)

router.get(
  '/dex-suggestions',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    if (!isPersonalWalletEnabled()) {
      res.json({ enabled: false, usdtFree: 0, items: [], disclaimer: '' })
      return
    }
    const payload = await getDexAllocationSuggestions(userId)
    res.json(payload)
  }),
)

router.get(
  '/activity',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const scopeRaw = String(req.query.scope ?? 'all')
    const scope: WalletActivityScope =
      scopeRaw === 'bsc' || scopeRaw === 'solana' || scopeRaw === 'cross' ? scopeRaw : 'all'
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))
    const items = await listWalletActivity(userId, scope, limit)
    res.json({ items })
  }),
)

router.get(
  '/withdrawals',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const items = await listWithdrawals(userId, 50)
    res.json({
      items: items.map((item) => ({
        id: item.id,
        asset: item.asset,
        amount: Number(item.amount),
        toAddress: item.toAddress,
        txHash: item.txHash,
        status: item.status,
        feeUsd: Number(item.feeUsd),
        errorMessage: item.errorMessage,
        requestedAt: item.requestedAt.toISOString(),
        processedAt: item.processedAt?.toISOString() ?? null,
      })),
    })
  }),
)

// ---- Cross-chain USDC transfer (BSC <-> Solana personal wallets) -----------

router.get(
  '/cross-chain/status',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId
    const directionRaw = req.query.direction
    const direction =
      directionRaw === 'BSC_TO_SOL' || directionRaw === 'SOL_TO_BSC' ? directionRaw : undefined
    const payload = await getCrossChainStatusPayload(userId, direction)
    res.json(payload)
  }),
)

router.get(
  '/cross-chain/assets',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const direction = req.query.direction
    if (direction !== 'BSC_TO_SOL' && direction !== 'SOL_TO_BSC') {
      res.status(400).json({ error: 'direction must be BSC_TO_SOL or SOL_TO_BSC' })
      return
    }
    const items = await listCrossChainSourceAssets(userId, direction)
    res.json({ items })
  }),
)

router.get(
  '/cross-chain/quote',
  asyncHandler(async (req: Request, res: Response) => {
    const amount = Number(req.query.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: 'amount must be a positive number' })
      return
    }
    const directionRaw = req.query.direction
    const sourceSymbol =
      typeof req.query.sourceSymbol === 'string' ? req.query.sourceSymbol : 'USDC'
    const destSymbol =
      typeof req.query.destSymbol === 'string' && req.query.destSymbol.length > 0
        ? req.query.destSymbol
        : undefined
    const userId = req.user?.userId
    if (
      userId &&
      (directionRaw === 'BSC_TO_SOL' || directionRaw === 'SOL_TO_BSC')
    ) {
      try {
        const preview = await previewCrossChainTransfer(userId, {
          direction: directionRaw,
          amount,
          sourceSymbol,
          destSymbol,
        })
        res.json(preview)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Quote failed'
        res.status(400).json({ error: message })
      }
      return
    }
    res.json(getCrossChainQuote(amount))
  }),
)

router.post(
  '/cross-chain/transfer',
  validate(crossChainTransferSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const { direction, amount, sourceSymbol, destSymbol } = (req as Request & {
      validated: { direction: CrossChainDirection; amount: number; sourceSymbol?: string; destSymbol?: string }
    }).validated
    try {
      const result = await executeCrossChainTransfer(userId, { direction, amount, sourceSymbol, destSymbol })
      res.json(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transfer failed'
      res.status(400).json({ error: message })
    }
  }),
)

router.post(
  '/cross-chain/retry/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const id = String(req.params.id ?? '')
    if (!id) {
      res.status(400).json({ error: 'Transfer id required' })
      return
    }
    try {
      const result = await retryCrossChainCredit(userId, id)
      res.json(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Retry failed'
      res.status(400).json({ error: message })
    }
  }),
)

router.get(
  '/cross-chain/transfers',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const items = await listCrossChainTransfers(userId, 20)
    res.json({
      items: items.map((item) => ({
        id: item.id,
        direction: item.direction,
        asset: item.asset,
        destAsset: item.destAsset ?? null,
        amount: Number(item.amount),
        creditAmount: Number(item.creditAmount),
        feeUsd: Number(item.feeUsd),
        status: item.status,
        debitTxRef: item.debitTxRef,
        creditTxRef: item.creditTxRef,
        errorMessage: item.errorMessage,
        requestedAt: item.requestedAt.toISOString(),
        processedAt: item.processedAt?.toISOString() ?? null,
      })),
    })
  }),
)

// ---- BSC same-chain convert (Pancake, no trade book) -----------------------

router.get(
  '/convert/catalog',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ items: listBscConvertCatalog() })
  }),
)

router.get(
  '/convert/quote',
  validate(bscConvertQuoteQuery),
  asyncHandler(async (req: Request, res: Response) => {
    const v = (req as Request & { validated: z.infer<typeof bscConvertQuoteQuery> }).validated
    try {
      const preview = await previewBscConvert(v)
      res.json(preview)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Quote failed'
      res.status(400).json({ error: message })
    }
  }),
)

router.post(
  '/convert',
  validate(bscConvertBody),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const body = (req as Request & { validated: z.infer<typeof bscConvertBody> }).validated
    try {
      const result = await convertBscTokens(userId, body)
      res.json(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Convert failed'
      res.status(400).json({ error: message })
    }
  }),
)

export default router
