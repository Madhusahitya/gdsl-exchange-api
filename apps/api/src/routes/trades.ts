import { Router, Request, Response } from 'express'
import { prisma, TradeStatus } from '@cryptoflow/db'
import { z } from 'zod'
import { authenticateToken } from '../middleware/authenticateToken'
import { validate } from '../middleware/validate'
import { asyncHandler } from '../middleware/asyncHandler'
import { tradesQuerySchema } from '../validators'
import { getSocketIo } from '../lib/realtimeHub'
import {
  displayRoundTripPnl,
  displayNetRoundTripPnl,
  shouldIncludeClosedTradeInPublicLog,
} from '../lib/roundTripPnl'
import { reconcileStaleJupiterOpenTrades } from '../services/dex/jupiterSwapService'

const router = Router()
const logExecutionSchema = z.object({
  pair: z.string().min(3).max(32),
  side: z.enum(['BUY', 'SELL']),
  /** Effective execution price (USDT per 1 base token). */
  entryPrice: z.number().positive(),
  /** USDT spent (BUY) or USDT received (SELL) — not the same as entry price. */
  allocationUsd: z.number().positive().optional(),
  /** Realized outcome vs pre-trade quote (slippage / pool fee effect), in USDT. */
  pnl: z.number().optional(),
  /** Omit for atomic DEX swaps (only meaningful for open→closed bot trades). */
  exitPrice: z.number().positive().optional(),
})

router.get('/', authenticateToken, validate(tradesQuerySchema), asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  await reconcileStaleJupiterOpenTrades(userId).catch(() => 0)
  const { page, limit, status, pair } = (req as Request & { validated: { page: number; limit: number; status: string; pair?: string } }).validated
  const skip = (page - 1) * limit

  const where: { userId: string; status?: TradeStatus; pair?: string } = { userId }

  if (status && status.toUpperCase() !== 'ALL') {
    const statusUpper = status.toUpperCase()
    if (statusUpper === 'OPEN' || statusUpper === 'CLOSED' || statusUpper === 'CANCELLED') {
      where.status = statusUpper as TradeStatus
    }
  }

  if (pair) where.pair = pair

  const total = await prisma.trade.count({ where })
  const totalPages = Math.ceil(total / limit)

  const rows = await prisma.trade.findMany({
    where,
    skip,
    take: limit,
    orderBy: { createdAt: 'desc' },
    include: { strategy: { select: { name: true, riskLevel: true } } },
  })

  // We don't have a dedicated `side` column on `Trade` (intentional — the
  // existing OPEN/CLOSED enum + nullable exitPrice already encode it), so
  // we derive it on read:
  //
  //   OPEN                                  → BUY  (position still held)
  //   CLOSED & exitPrice != null            → CLOSED (full round-trip, has realized PnL)
  //   CLOSED & exitPrice == null            → SELL  (orphan / standalone sell)
  //   CANCELLED                             → CANCELLED (ghost lot cleared — not a sell)
  const deriveSide = (
    status: TradeStatus,
    exitPrice: unknown,
  ): 'BUY' | 'SELL' | 'CLOSED' | 'CANCELLED' => {
    if (status === 'CANCELLED') return 'CANCELLED'
    if (status === 'OPEN') return 'BUY'
    if (exitPrice != null) return 'CLOSED'
    return 'SELL'
  }

  const visibleRows = rows.filter((trade) => {
    if (trade.status !== TradeStatus.CLOSED || trade.exitPrice == null) return true
    return shouldIncludeClosedTradeInPublicLog({
      pnl: trade.pnl,
      allocationUsd: trade.allocationUsd,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      pair: trade.pair,
      strategyName: trade.strategy.name,
    })
  })

  const trades = visibleRows.map((trade) => {
    const exitPrice = trade.exitPrice ? Number(trade.exitPrice) : null
    const storedPnl = trade.pnl != null ? Number(trade.pnl) : null
    const pnlRow = {
      pnl: storedPnl,
      allocationUsd: trade.allocationUsd,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      strategyName: trade.strategy.name,
    }
    const grossPnl =
      trade.status === 'CLOSED' && exitPrice != null
        ? displayRoundTripPnl(pnlRow) ?? storedPnl
        : storedPnl
    const netPnl =
      trade.status === 'CLOSED' && exitPrice != null ? displayNetRoundTripPnl(pnlRow) : null
    return {
    id: trade.id,
    pair: trade.pair,
    entryPrice: Number(trade.entryPrice),
    exitPrice,
    pnl: netPnl ?? grossPnl,
    grossPnl,
    netPnl,
    allocationUsd: trade.allocationUsd != null ? Number(trade.allocationUsd) : null,
    status: trade.status,
    side: deriveSide(trade.status, trade.exitPrice),
    strategy: trade.strategy.name,
    riskLevel: trade.strategy.riskLevel,
    createdAt: trade.createdAt,
  }
  })

  res.json({ trades, total, page, totalPages })
}))

router.get('/:id', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const tradeId = String(req.params.id)

  const trade = await prisma.trade.findUnique({
    where: { id: tradeId },
    include: { strategy: { select: { name: true, description: true, riskLevel: true } } },
  })

  if (!trade || trade.userId !== userId) {
    res.status(404).json({ error: 'Trade not found' })
    return
  }

  const side: 'BUY' | 'SELL' | 'CLOSED' | 'CANCELLED' =
    trade.status === 'CANCELLED'
      ? 'CANCELLED'
      : trade.status === 'OPEN'
        ? 'BUY'
        : trade.exitPrice != null
          ? 'CLOSED'
          : 'SELL'

  res.json({
    id: trade.id,
    pair: trade.pair,
    entryPrice: Number(trade.entryPrice),
    exitPrice: trade.exitPrice ? Number(trade.exitPrice) : null,
    pnl: trade.pnl != null ? Number(trade.pnl) : null,
    allocationUsd: trade.allocationUsd != null ? Number(trade.allocationUsd) : null,
    status: trade.status,
    side,
    strategy: {
      name: trade.strategy.name,
      description: trade.strategy.description,
      riskLevel: trade.strategy.riskLevel,
    },
    createdAt: trade.createdAt,
  })
}))

router.post('/log-execution', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const parsed = logExecutionSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid execution payload' })
    return
  }
  const { pair, side, entryPrice, allocationUsd, pnl, exitPrice } = parsed.data
  const strategy = await prisma.strategy.upsert({
    where: { name: 'DEX External Wallet' },
    update: {},
    create: {
      name: 'DEX External Wallet',
      description: 'On-chain swaps executed from connected user wallets (MetaMask/Trust/WalletConnect).',
      riskLevel: 'MEDIUM',
    },
    select: { id: true },
  })

  // Position-lifecycle recording (mirrors personalWalletService — see the
  // long comment there for the why). MetaMask flows POST to this endpoint
  // after the swap confirms; the client always passes `side`, so we know
  // whether to open a new position or close the oldest open one.
  let created
  let derivedSide: 'BUY' | 'SELL' | 'CLOSED'
  let derivedStatus: 'OPEN' | 'CLOSED'

  if (side === 'BUY') {
    created = await prisma.trade.create({
      data: {
        userId,
        strategyId: strategy.id,
        pair,
        entryPrice,
        exitPrice: null,
        // Always null for opens — realized only materializes at SELL time.
        // We deliberately ignore any client-supplied `pnl` for BUYs so a
        // bad/old client can't poison the ledger.
        pnl: null,
        allocationUsd: allocationUsd ?? null,
        status: 'OPEN',
      },
    })
    derivedSide = 'BUY'
    derivedStatus = 'OPEN'
  } else {
    // SELL: try to close the oldest OPEN position in this book.
    const openPos = await prisma.trade.findFirst({
      where: { userId, pair, strategyId: strategy.id, status: 'OPEN' },
      orderBy: { createdAt: 'asc' },
    })

    if (openPos) {
      const buyAlloc = Number(openPos.allocationUsd ?? 0)
      const sellAlloc = allocationUsd ?? 0
      const realizedRaw = sellAlloc - buyAlloc
      const realized = Number.isFinite(realizedRaw)
        ? Math.round(realizedRaw * 1e8) / 1e8
        : 0
      created = await prisma.trade.update({
        where: { id: openPos.id },
        data: {
          // The SELL's fill price becomes the exit price of the BUY row.
          exitPrice: entryPrice,
          pnl: realized,
          status: 'CLOSED',
        },
      })
      derivedSide = 'CLOSED'
      derivedStatus = 'CLOSED'
    } else {
      // Orphan SELL — keep an audit trail but don't fake a round-trip PnL.
      // The client may still send a `pnl` value (e.g. its own slippage
      // estimate); we accept it but the dashboard will display it as a
      // standalone SELL row (exitPrice still null).
      created = await prisma.trade.create({
        data: {
          userId,
          strategyId: strategy.id,
          pair,
          entryPrice,
          exitPrice: exitPrice ?? null,
          pnl: pnl ?? null,
          allocationUsd: allocationUsd ?? null,
          status: 'CLOSED',
        },
      })
      derivedSide = 'SELL'
      derivedStatus = 'CLOSED'
    }
  }

  const io = getSocketIo()
  if (io) {
    io.to(`user:${userId}`).emit('trade:executed', {
      trade: {
        id: created.id,
        pair,
        signal: side,
        price: Number(entryPrice),
        entryPrice: Number(created.entryPrice),
        exitPrice: created.exitPrice != null ? Number(created.exitPrice) : null,
        pnl: created.pnl != null ? Number(created.pnl) : null,
        status: created.status,
        side: derivedSide,
      },
      currentPnl: created.pnl != null ? Number(created.pnl) : 0,
    })
  }

  res.status(201).json({
    id: created.id,
    pair,
    side: derivedSide,
    status: derivedStatus,
  })
}))

export default router
