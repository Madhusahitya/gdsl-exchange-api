import { prisma, OrderSide, OrderStatus, OrderType, TimeInForce, ExecutionEventType } from '@cryptoflow/db'
import { adjustQuantityToLotSize, notionalForQuantity } from '@cryptoflow/binance-executor'
import { decryptSecret } from '../../lib/crypto'
import { logger } from '../../lib/logger'
import { binanceAdapter } from '../exchange/binanceAdapter'
import { tryGetBinanceSymbolRules } from '../exchange/binanceSymbolRulesService'
import { checkRisk } from './risk'
import { canTransitionOrderStatus } from './stateMachine'

export type CreateOrderInput = {
  userId: string
  exchangeConnectionId: string
  symbol: string
  side: OrderSide
  type: OrderType
  quantity: number
  /** MARKET BUY: spend this much USDT (Binance quoteOrderQty) */
  quoteOrderQty?: number
  price?: number
  timeInForce?: TimeInForce
  stopLossPrice?: number
  takeProfitPrice?: number
  trailingPercent?: number
}

/**
 * Floor a base quantity to the symbol's stepSize and reject it early if the
 * resulting notional is under Binance's minimum. Returns the exchange-ready
 * quantity string, or null when we could not resolve the symbol's filters (in
 * which case we submit as-is and let Binance be the judge).
 */
async function normalizeBaseQuantity(
  symbol: string,
  quantity: number,
  referencePrice: number,
): Promise<string | null> {
  const rules = await tryGetBinanceSymbolRules(symbol)
  if (!rules) return null

  const qtyStr = adjustQuantityToLotSize(quantity, rules)
  if (rules.minNotional > 0 && referencePrice > 0) {
    const notional = notionalForQuantity(qtyStr, referencePrice)
    if (notional < rules.minNotional - 1e-8) {
      throw new Error(
        `Order notional $${notional.toFixed(2)} is below the Binance minimum of $${rules.minNotional} for ${symbol}`,
      )
    }
  }
  return qtyStr
}

export async function placeOrder(input: CreateOrderInput) {
  const connection = await prisma.exchangeConnection.findFirst({
    where: { id: input.exchangeConnectionId, userId: input.userId, isActive: true },
  })
  if (!connection) throw new Error('Exchange connection not found')
  if (!connection.canTrade) throw new Error('This exchange key has no trade permissions')

  const referencePrice = input.price ?? 0
  const risk = await checkRisk({
    userId: input.userId,
    symbol: input.symbol,
    quantity: input.quantity,
    price: referencePrice || 1,
    notionalUsd: input.quoteOrderQty,
  })
  if (!risk.allowed) throw new Error(risk.reason ?? 'Risk check failed')

  // Binance rejects (-1013 / -1111) anything off stepSize or under minNotional.
  // Do it here so every caller — OMS, live bot, Auto Binance — is covered.
  let quantityStr: string | null = null
  if (input.quoteOrderQty) {
    const rules = await tryGetBinanceSymbolRules(input.symbol)
    if (rules && rules.minNotional > 0 && input.quoteOrderQty < rules.minNotional - 1e-8) {
      throw new Error(
        `Order size $${input.quoteOrderQty.toFixed(2)} is below the Binance minimum of $${rules.minNotional} for ${input.symbol}`,
      )
    }
  } else {
    quantityStr = await normalizeBaseQuantity(input.symbol, input.quantity, referencePrice)
    if (quantityStr != null && Number(quantityStr) !== input.quantity) {
      logger.debug(
        { symbol: input.symbol, requested: input.quantity, adjusted: quantityStr },
        '[oms] quantity floored to stepSize',
      )
    }
  }
  const submitQuantity = quantityStr ?? input.quantity.toString()

  const clientOrderId = `cf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const order = await prisma.order.create({
    data: {
      userId: input.userId,
      exchangeConnectionId: input.exchangeConnectionId,
      clientOrderId,
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      quantity: input.quoteOrderQty ?? Number(submitQuantity),
      price: input.price,
      timeInForce: input.timeInForce,
      stopPrice: input.stopLossPrice,
      takeProfitPrice: input.takeProfitPrice,
      trailingPercent: input.trailingPercent,
      status: OrderStatus.PENDING_SUBMIT,
    },
  })

  try {
    const apiKey = decryptSecret(connection.encryptedApiKey)
    const apiSecret = decryptSecret(connection.encryptedSecret)
    const remoteOrder = await binanceAdapter.placeOrder({
      apiKey,
      apiSecret,
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      quantity: input.quoteOrderQty ? undefined : submitQuantity,
      quoteOrderQty: input.quoteOrderQty ? input.quoteOrderQty.toFixed(2) : undefined,
      price: input.price?.toString(),
      timeInForce: input.timeInForce,
      clientOrderId,
    }) as {
      status: string
      orderId: string | number
      price?: string
      executedQty?: string
      cummulativeQuoteQty?: string
    }

    const incomingStatus = remoteOrder.status as OrderStatus
    if (!canTransitionOrderStatus(OrderStatus.PENDING_SUBMIT, incomingStatus)) {
      throw new Error(`Invalid order status transition: PENDING_SUBMIT → ${incomingStatus}`)
    }

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        status: incomingStatus,
        exchangeOrderId: String(remoteOrder.orderId),
        submittedAt: new Date(),
        filledQuantity: remoteOrder.executedQty ? Number(remoteOrder.executedQty) : undefined,
        quoteQuantity: remoteOrder.cummulativeQuoteQty ? Number(remoteOrder.cummulativeQuoteQty) : undefined,
        avgFillPrice:
          remoteOrder.executedQty && remoteOrder.cummulativeQuoteQty && Number(remoteOrder.executedQty) > 0
            ? Number(remoteOrder.cummulativeQuoteQty) / Number(remoteOrder.executedQty)
            : undefined,
      },
    })

    await prisma.executionEvent.create({
      data: {
        userId: input.userId,
        orderId: updated.id,
        eventType: ExecutionEventType.ORDER_SUBMITTED,
        payload: remoteOrder as any,
      },
    })
    return updated
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to place order'
    await prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.REJECTED, rejectReason: message, closedAt: new Date() },
    })
    await prisma.executionEvent.create({
      data: {
        userId: input.userId,
        orderId: order.id,
        eventType: ExecutionEventType.ORDER_REJECTED,
        payload: { message } as any,
      },
    })
    throw error
  }
}

export async function syncOrderStatus(userId: string, orderId: string) {
  const order = await prisma.order.findFirst({ where: { id: orderId, userId }, include: { exchangeConnection: true } })
  if (!order || !order.exchangeOrderId) throw new Error('Order not found')

  const apiKey = decryptSecret(order.exchangeConnection.encryptedApiKey)
  const apiSecret = decryptSecret(order.exchangeConnection.encryptedSecret)
  const remote = await binanceAdapter.getOrder(apiKey, apiSecret, order.symbol, order.exchangeOrderId) as {
    status: string
    price?: string
    executedQty?: string
    cummulativeQuoteQty?: string
  }

  const status = remote.status as OrderStatus
  if (!canTransitionOrderStatus(order.status, status)) {
    throw new Error(`Invalid order status transition: ${order.status} → ${status}`)
  }

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: {
      status,
      avgFillPrice: remote.price ? Number(remote.price) : undefined,
      filledQuantity: remote.executedQty ? Number(remote.executedQty) : order.filledQuantity,
      quoteQuantity: remote.cummulativeQuoteQty ? Number(remote.cummulativeQuoteQty) : order.quoteQuantity,
      closedAt: status === OrderStatus.FILLED || status === OrderStatus.CANCELED || status === OrderStatus.EXPIRED ? new Date() : null,
    },
  })
  await prisma.executionEvent.create({
    data: { userId, orderId: order.id, eventType: ExecutionEventType.ORDER_UPDATED, payload: remote as any },
  })
  return updated
}
