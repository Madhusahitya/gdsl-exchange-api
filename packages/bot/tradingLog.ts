import { prisma } from '@cryptoflow/db'
import type { Prisma } from '@prisma/client'

export type TradingLogKind =
  | 'SIGNAL'
  | 'EXEC'
  | 'RISK'
  | 'WEBHOOK'
  | 'SYSTEM'
  | 'FILTER'
  | 'trade.attempt'
  | 'trade.validation.failed'
  | 'trade.execution.success'
  | 'trade.execution.failed'

export async function appendTradingLog(
  userId: string,
  kind: TradingLogKind,
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await prisma.tradingLog.create({
    data: {
      userId,
      kind,
      message,
      metadata: metadata !== undefined ? (metadata as Prisma.InputJsonValue) : undefined,
    },
  })
}
