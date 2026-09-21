/**
 * Retry / complete cross-chain credits stuck after a successful debit leg.
 */
import { CrossChainTransferStatus, prisma } from '@cryptoflow/db'
import { logger } from '../../lib/logger'
import { resolveCrossChainPair } from '../../lib/crossChainTokenCatalog'
import {
  executeCrossChainCreditLeg,
  type CrossChainTransferResult,
} from './crossChainTransferService'

export async function retryCrossChainCredit(
  userId: string,
  transferId: string,
): Promise<CrossChainTransferResult> {
  const record = await prisma.crossChainTransfer.findFirst({
    where: { id: transferId, userId },
  })
  if (!record) throw new Error('Transfer not found')
  if (record.status === CrossChainTransferStatus.COMPLETED) {
    return {
      id: record.id,
      status: record.status,
      direction: record.direction as 'BSC_TO_SOL' | 'SOL_TO_BSC',
      amount: Number(record.amount),
      creditAmount: Number(record.creditAmount),
      feeUsd: Number(record.feeUsd),
      debitTxRef: record.debitTxRef ?? '',
      creditTxRef: record.creditTxRef ?? '',
    }
  }
  if (
    record.status !== CrossChainTransferStatus.CREDIT_PENDING &&
    record.status !== CrossChainTransferStatus.DEBITED
  ) {
    throw new Error(`Transfer cannot be retried in status ${record.status}`)
  }
  if (!record.debitTxRef) throw new Error('Missing debit transaction — contact support')

  return executeCrossChainCreditLeg(userId, record.id)
}

export async function retryAllPendingCrossChainCredits(limit = 20): Promise<number> {
  const pending = await prisma.crossChainTransfer.findMany({
    where: { status: CrossChainTransferStatus.CREDIT_PENDING },
    orderBy: { requestedAt: 'asc' },
    take: limit,
  })
  let done = 0
  for (const row of pending) {
    try {
      await executeCrossChainCreditLeg(row.userId, row.id)
      done++
    } catch (err) {
      logger.warn(
        { transferId: row.id, userId: row.userId, err: (err as Error).message },
        '[cross-chain] automatic credit retry still pending',
      )
    }
  }
  return done
}
