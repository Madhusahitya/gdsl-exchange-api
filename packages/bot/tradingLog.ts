import { prisma, type Prisma } from '@cryptoflow/db'

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
