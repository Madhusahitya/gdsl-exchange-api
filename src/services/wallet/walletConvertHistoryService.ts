import { prisma } from '@cryptoflow/db'

export type WalletConvertChain = 'BSC' | 'SOLANA'

export async function recordWalletConvert(
  userId: string,
  chain: WalletConvertChain,
  params: {
    fromSymbol: string
    toSymbol: string
    inAmount: number
    outAmount: number
    txRef: string
  },
): Promise<void> {
  await prisma.walletConvert.create({
    data: {
      userId,
      chain,
      fromSymbol: params.fromSymbol.toUpperCase(),
      toSymbol: params.toSymbol.toUpperCase(),
      inAmount: params.inAmount,
      outAmount: params.outAmount,
      txRef: params.txRef,
    },
  })
}

export async function listWalletConverts(userId: string, chain?: WalletConvertChain, limit = 40) {
  return prisma.walletConvert.findMany({
    where: { userId, ...(chain ? { chain } : {}) },
    orderBy: { requestedAt: 'desc' },
    take: Math.min(100, Math.max(1, limit)),
  })
}
