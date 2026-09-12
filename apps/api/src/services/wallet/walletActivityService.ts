import { listWalletConverts } from './walletConvertHistoryService'
import { listCrossChainTransfers } from './crossChainTransferService'
import { listWithdrawals } from './personalWalletService'
import { prisma } from '@cryptoflow/db'

export type WalletActivityScope = 'bsc' | 'solana' | 'cross' | 'all'

export type WalletActivityItem = {
  id: string
  at: string
  chain: 'BSC' | 'Solana' | 'Cross-chain'
  type: 'Withdraw' | 'Convert' | 'Transfer'
  detail: string
  amount: string
  status: string
  txLink?: string
  txLink2?: string
  transferId?: string
  canRetryCredit?: boolean
  statusNote?: string
}

function shortAddr(addr: string): string {
  if (addr.length <= 14) return addr
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`
}

export async function listWalletActivity(
  userId: string,
  scope: WalletActivityScope = 'all',
  limit = 50,
): Promise<WalletActivityItem[]> {
  const items: WalletActivityItem[] = []
  const cap = Math.min(100, Math.max(1, limit))

  if (scope === 'all' || scope === 'bsc') {
    const bscWd = await listWithdrawals(userId, cap)
    for (const w of bscWd) {
      items.push({
        id: `bsc-wd-${w.id}`,
        at: w.requestedAt.toISOString(),
        chain: 'BSC',
        type: 'Withdraw',
        detail: `To ${shortAddr(w.toAddress)}`,
        amount: `${Number(w.amount)} ${w.asset}`,
        status: w.status,
        txLink: w.txHash ? `https://bscscan.com/tx/${w.txHash}` : undefined,
      })
    }

    const bscConverts = await listWalletConverts(userId, 'BSC', cap)
    for (const c of bscConverts) {
      items.push({
        id: `bsc-cv-${c.id}`,
        at: c.requestedAt.toISOString(),
        chain: 'BSC',
        type: 'Convert',
        detail: `${c.fromSymbol} → ${c.toSymbol}`,
        amount: `${Number(c.inAmount)} ${c.fromSymbol} → ${Number(c.outAmount)} ${c.toSymbol}`,
        status: 'COMPLETED',
        txLink: `https://bscscan.com/tx/${c.txRef}`,
      })
    }
  }

  if (scope === 'all' || scope === 'solana') {
    const solWd = await prisma.solanaPersonalWalletWithdrawal.findMany({
      where: { userId },
      orderBy: { requestedAt: 'desc' },
      take: cap,
    })
    for (const w of solWd) {
      items.push({
        id: `sol-wd-${w.id}`,
        at: w.requestedAt.toISOString(),
        chain: 'Solana',
        type: 'Withdraw',
        detail: `To ${shortAddr(w.toAddress)}`,
        amount: `${Number(w.amount)} ${w.asset}`,
        status: w.status,
        txLink: w.txSignature ? `https://solscan.io/tx/${w.txSignature}` : undefined,
      })
    }

    const solConverts = await listWalletConverts(userId, 'SOLANA', cap)
    for (const c of solConverts) {
      items.push({
        id: `sol-cv-${c.id}`,
        at: c.requestedAt.toISOString(),
        chain: 'Solana',
        type: 'Convert',
        detail: `${c.fromSymbol} → ${c.toSymbol}`,
        amount: `${Number(c.inAmount)} ${c.fromSymbol} → ${Number(c.outAmount)} ${c.toSymbol}`,
        status: 'COMPLETED',
        txLink: `https://solscan.io/tx/${c.txRef}`,
      })
    }
  }

  if (scope === 'all' || scope === 'cross' || scope === 'bsc' || scope === 'solana') {
    const xfers = await listCrossChainTransfers(userId, cap)
    for (const t of xfers) {
      const asset = t.asset || 'USDC'
      const dirLabel = t.direction === 'BSC_TO_SOL' ? 'BSC → Solana' : 'Solana → BSC'
      items.push({
        id: `xfer-${t.id}`,
        at: t.requestedAt.toISOString(),
        chain: 'Cross-chain',
        type: 'Transfer',
        detail: `${dirLabel} · ${asset}`,
        amount: `${Number(t.amount)} ${asset} → ${Number(t.creditAmount)} ${asset} (fee $${Number(t.feeUsd)})`,
        status: t.status,
        transferId: t.id,
        canRetryCredit: t.status === 'CREDIT_PENDING',
        statusNote:
          t.status === 'CREDIT_PENDING'
            ? 'Funds are safe on BSC. Delivery retries automatically once operator bridge wallet has BNB for gas.'
            : undefined,
        txLink: t.debitTxRef
          ? t.direction === 'BSC_TO_SOL'
            ? `https://bscscan.com/tx/${t.debitTxRef}`
            : `https://solscan.io/tx/${t.debitTxRef}`
          : undefined,
        txLink2: t.creditTxRef
          ? t.direction === 'BSC_TO_SOL'
            ? `https://solscan.io/tx/${t.creditTxRef}`
            : `https://bscscan.com/tx/${t.creditTxRef}`
          : undefined,
      })
    }
  }

  items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
  return items.slice(0, cap)
}
