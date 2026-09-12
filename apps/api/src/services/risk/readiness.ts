import { prisma } from '@cryptoflow/db'
import { env } from '../../lib/env'

type ReadinessConnection = {
  id: string
  label: string | null
  exchange: string
}

export type AutomationReadiness = {
  ready: boolean
  hasRiskPolicyEnabled: boolean
  hasSafeTradableConnection: boolean
  liveAutomationEnabled: boolean
  maintenanceReason: string | null
  blockers: string[]
  safeConnections: ReadinessConnection[]
}

/**
 * Shared live-automation readiness check for non-custodial Binance mode.
 * This is the single source of truth used by both API routes and frontend.
 */
export async function computeAutomationReadiness(
  userId: string,
  selectedExchangeConnectionId?: string
): Promise<AutomationReadiness> {
  const [riskRule, connections] = await Promise.all([
    prisma.riskRule.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.exchangeConnection.findMany({
      where: { userId, isActive: true, exchange: 'BINANCE' },
      select: {
        id: true,
        label: true,
        canTrade: true,
        canWithdraw: true,
        exchange: true,
      },
    }),
  ])

  const hasRiskPolicyEnabled = !!riskRule?.isEnabled
  const safeTradableConnections = connections.filter((c) => c.canTrade && !c.canWithdraw)
  const hasSafeTradableConnection = safeTradableConnections.length > 0
  const liveAutomationEnabled = env.LIVE_AUTOMATION_ENABLED
  const maintenanceReason = env.LIVE_AUTOMATION_MAINTENANCE_REASON ?? null

  const blockers: string[] = []
  if (!liveAutomationEnabled) {
    blockers.push(
      maintenanceReason
        ? `Live automation is currently disabled: ${maintenanceReason}`
        : 'Live automation is currently disabled by operator.'
    )
  }
  if (!hasSafeTradableConnection) {
    blockers.push('No active trade-only Binance key found (withdraw must be disabled).')
  }
  if (!hasRiskPolicyEnabled) {
    blockers.push('Risk policy is not enabled. Configure it in Settings.')
  }

  if (selectedExchangeConnectionId) {
    const selected = connections.find((c) => c.id === selectedExchangeConnectionId)
    if (!selected) {
      blockers.push('Selected Binance connection was not found or is inactive.')
    } else if (!selected.canTrade) {
      blockers.push('Selected Binance key does not have trading permission enabled.')
    } else if (selected.canWithdraw) {
      blockers.push('Selected Binance key has withdraw enabled. Use a trade-only key.')
    }
  }

  return {
    ready: blockers.length === 0,
    hasRiskPolicyEnabled,
    hasSafeTradableConnection,
    liveAutomationEnabled,
    maintenanceReason,
    blockers,
    safeConnections: safeTradableConnections.map((c) => ({
      id: c.id,
      label: c.label,
      exchange: c.exchange,
    })),
  }
}
