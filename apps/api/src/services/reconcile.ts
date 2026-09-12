import { prisma, OrderStatus } from '@cryptoflow/db'
import { decryptSecret } from '../lib/crypto'
import { binanceAdapter } from './exchange/binanceAdapter'
import { logger } from '../lib/logger'
import { canTransitionOrderStatus } from './orders/stateMachine'

const TERMINAL_STATUSES: OrderStatus[] = ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']

export async function reconcileOpenOrders(): Promise<void> {
  const openOrders = await prisma.order.findMany({
    where: { status: { notIn: TERMINAL_STATUSES } },
    include: { exchangeConnection: true },
    take: 200,
  })

  for (const order of openOrders) {
    if (!order.exchangeOrderId) continue
    try {
      const remote = await binanceAdapter.getOrder(
        decryptSecret(order.exchangeConnection.encryptedApiKey),
        decryptSecret(order.exchangeConnection.encryptedSecret),
        order.symbol,
        order.exchangeOrderId
      ) as { status: string; executedQty?: string; cummulativeQuoteQty?: string }
      const nextStatus = remote.status as OrderStatus

      if (!canTransitionOrderStatus(order.status, nextStatus)) {
        logger.warn(`[reconcile] Skipping invalid transition ${order.status} → ${nextStatus} for order ${order.id}`)
        continue
      }

      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: nextStatus,
          filledQuantity: remote.executedQty ? Number(remote.executedQty) : order.filledQuantity,
          quoteQuantity: remote.cummulativeQuoteQty ? Number(remote.cummulativeQuoteQty) : order.quoteQuantity,
          closedAt: TERMINAL_STATUSES.includes(nextStatus) ? new Date() : null,
        },
      })
    } catch (err) {
      logger.error({ err, orderId: order.id }, '[reconcile] Failed to reconcile order')
    }
  }
}
