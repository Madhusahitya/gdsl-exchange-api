/**
 * Risk gate: checks RiskRule limits before any order is placed.
 * Logs to RiskEvent on violation.
 */
import { prisma } from '@cryptoflow/db'
import { logger } from '../../lib/logger'

export type RiskCheckResult = { ok: true } | { ok: false; reason: string }

export async function checkRisk(
  userId:       string,
  orderSizeUsdt: number,
): Promise<RiskCheckResult> {
  const rule = await prisma.riskRule.findFirst({ where: { userId, isEnabled: true } })
  if (!rule) return { ok: true }

  // 1. Max single-order notional
  if (rule.maxOrderNotional && orderSizeUsdt > Number(rule.maxOrderNotional)) {
    return fail(userId, 'ORDER_REJECTED',
      `Order size ${orderSizeUsdt.toFixed(2)} USDT exceeds maxOrderNotional ${rule.maxOrderNotional}`)
  }

  // 2. Max open exposure
  if (rule.maxOpenNotional) {
    const openTrades = await prisma.trade.count({ where: { userId, status: 'OPEN' } })
    const exposure   = openTrades * orderSizeUsdt
    if (exposure > Number(rule.maxOpenNotional)) {
      return fail(userId, 'OPEN_EXPOSURE_LIMIT',
        `Open exposure ${exposure.toFixed(2)} USDT exceeds maxOpenNotional ${rule.maxOpenNotional}`)
    }
  }

  // 3. Daily loss limit
  if (rule.maxDailyLoss) {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
    const trades = await prisma.trade.findMany({
      where: { userId, status: 'CLOSED', createdAt: { gte: todayStart } },
      select: { pnl: true },
    })
    const dailyPnl = trades.reduce((s, t) => s + Number(t.pnl ?? 0), 0)
    if (dailyPnl < -Number(rule.maxDailyLoss)) {
      return fail(userId, 'DAILY_LOSS_LIMIT',
        `Daily PnL ${dailyPnl.toFixed(2)} USDT exceeded daily loss limit ${rule.maxDailyLoss}`)
    }
  }

  // 4. Losing streak cooldown
  if (rule.maxLosingStreak && rule.maxLosingStreak > 0) {
    const recent = await prisma.trade.findMany({
      where: { userId, status: 'CLOSED' },
      orderBy: { createdAt: 'desc' },
      take: rule.maxLosingStreak,
      select: { pnl: true, createdAt: true },
    })
    if (recent.length >= rule.maxLosingStreak && recent.every((t) => Number(t.pnl) < 0)) {
      const lastLoss = recent[0].createdAt
      const cooldownMs = (rule.cooldownMinutes ?? 0) * 60_000
      if (Date.now() - lastLoss.getTime() < cooldownMs) {
        return fail(userId, 'LOSING_STREAK_COOLDOWN',
          `${rule.maxLosingStreak} consecutive losses, cooling down for ${rule.cooldownMinutes}m`)
      }
    }
  }

  return { ok: true }
}

async function fail(
  userId: string,
  kind: 'ORDER_REJECTED' | 'DAILY_LOSS_LIMIT' | 'OPEN_EXPOSURE_LIMIT' | 'LOSING_STREAK_COOLDOWN' | 'CIRCUIT_BREAKER',
  message: string,
): Promise<RiskCheckResult> {
  logger.warn(`[riskGate] ${kind}: ${message}`)
  await prisma.riskEvent.create({
    data: { userId, kind, severity: 'WARN', message },
  }).catch(() => {})
  return { ok: false, reason: message }
}
