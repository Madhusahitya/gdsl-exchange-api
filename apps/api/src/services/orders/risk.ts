import { prisma, RiskEventKind, RiskSeverity } from '@cryptoflow/db'

export type RiskCheckInput = {
  userId: string
  symbol: string
  quantity: number
  price: number
  /** When set (e.g. MARKET BUY with quoteOrderQty), used instead of quantity * price */
  notionalUsd?: number
}

export async function checkRisk(input: RiskCheckInput): Promise<{ allowed: boolean; reason?: string }> {
  const activeRule = await prisma.riskRule.findFirst({
    where: { userId: input.userId, isEnabled: true },
    orderBy: { updatedAt: 'desc' },
  })
  if (!activeRule) return { allowed: true }

  const notional = input.notionalUsd ?? input.quantity * input.price
  if (activeRule.maxOrderNotional && notional > Number(activeRule.maxOrderNotional)) {
    const reason = `Order notional ${notional.toFixed(2)} exceeds max ${Number(activeRule.maxOrderNotional).toFixed(2)}`
    await prisma.riskEvent.create({
      data: { userId: input.userId, kind: RiskEventKind.ORDER_REJECTED, severity: RiskSeverity.WARN, message: reason, metadata: { symbol: input.symbol, notional } },
    })
    return { allowed: false, reason }
  }

  if (activeRule.maxDailyLoss) {
    const start = new Date()
    start.setUTCHours(0, 0, 0, 0)
    const todayTrades = await prisma.trade.findMany({
      where: { userId: input.userId, status: 'CLOSED', createdAt: { gte: start } },
      select: { pnl: true },
    })
    const dailyPnl = todayTrades.reduce((acc, t) => acc + Number(t.pnl ?? 0), 0)
    if (dailyPnl <= -Math.abs(Number(activeRule.maxDailyLoss))) {
      const reason = 'Daily loss limit reached'
      await prisma.riskEvent.create({
        data: { userId: input.userId, kind: RiskEventKind.DAILY_LOSS_LIMIT, severity: RiskSeverity.CRITICAL, message: reason, metadata: { dailyPnl } },
      })
      return { allowed: false, reason }
    }
  }

  return { allowed: true }
}
