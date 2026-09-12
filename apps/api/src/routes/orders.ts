import { Router, Request, Response } from 'express'
import { OrderStatus } from '@cryptoflow/db'
import { authenticateToken } from '../middleware/authenticateToken'
import { validate } from '../middleware/validate'
import { asyncHandler } from '../middleware/asyncHandler'
import { createOrderSchema, listOrdersSchema } from '../validators'
import { placeOrder, syncOrderStatus } from '../services/orders/orderService'
import { prisma } from '@cryptoflow/db'

const router = Router()

router.post('/', authenticateToken, validate(createOrderSchema), asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const data = (req as Request & { validated: {
    exchangeConnectionId: string
    symbol: 'BTCUSDT' | 'ETHUSDT' | 'SOLUSDT'
    side: 'BUY' | 'SELL'
    type: 'MARKET' | 'LIMIT'
    quantity: number
    price?: number
    timeInForce?: 'GTC' | 'IOC' | 'FOK'
    stopLossPrice?: number
    takeProfitPrice?: number
    trailingPercent?: number
  } }).validated

  const order = await placeOrder({
    userId,
    exchangeConnectionId: data.exchangeConnectionId,
    symbol: data.symbol,
    side: data.side,
    type: data.type,
    quantity: data.quantity,
    price: data.price,
    timeInForce: data.timeInForce,
    stopLossPrice: data.stopLossPrice,
    takeProfitPrice: data.takeProfitPrice,
    trailingPercent: data.trailingPercent,
  })
  res.status(201).json(order)
}))

router.get('/', authenticateToken, validate(listOrdersSchema), asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const { status, symbol, page, limit } = (req as Request & { validated: { status: OrderStatus | 'ALL'; symbol?: string; page: number; limit: number } }).validated
  const skip = (page - 1) * limit
  const where = {
    userId,
    ...(status !== 'ALL' ? { status } : {}),
    ...(symbol ? { symbol } : {}),
  }

  const [total, orders] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
  ])

  res.json({ total, page, totalPages: Math.ceil(total / limit), orders })
}))

router.post('/:id/sync', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const id = String(req.params.id)
  const updated = await syncOrderStatus(userId, id)
  res.json(updated)
}))

export default router
