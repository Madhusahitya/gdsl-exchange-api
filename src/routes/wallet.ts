import { Router, Request, Response } from 'express'
import { prisma } from '@cryptoflow/db'
import { authenticateToken } from '../middleware/authenticateToken'
import { asyncHandler } from '../middleware/asyncHandler'
import { decryptSecret } from '../lib/crypto'
import { binanceAdapter } from '../services/exchange/binanceAdapter'

const router = Router()

router.post('/sync', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const connection = await prisma.exchangeConnection.findFirst({ where: { userId, isActive: true } })
  if (!connection) {
    res.status(404).json({ error: 'No active exchange connection' })
    return
  }

  const balances = await binanceAdapter.getBalances(
    decryptSecret(connection.encryptedApiKey),
    decryptSecret(connection.encryptedSecret)
  )

  const snapshot = await prisma.walletBalanceSnapshot.create({
    data: {
      userId,
      exchangeConnectionId: connection.id,
      totalUsdValue: 0,
      assetBalances: {
        create: balances.map((b) => {
          const free = Number(b.free)
          const locked = Number(b.locked)
          return {
            asset: b.asset,
            free,
            locked,
            total: free + locked,
            usdValue: 0,
          }
        }),
      },
    },
    include: { assetBalances: true },
  })
  res.json(snapshot)
}))

router.get('/balances', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const latest = await prisma.walletBalanceSnapshot.findFirst({
    where: { userId },
    orderBy: { capturedAt: 'desc' },
    include: { assetBalances: true },
  })
  if (!latest) {
    res.json({ capturedAt: null, assets: [] })
    return
  }
  res.json({
    capturedAt: latest.capturedAt,
    assets: latest.assetBalances.map((a) => ({
      asset: a.asset,
      free: Number(a.free),
      locked: Number(a.locked),
      total: Number(a.total),
      usdValue: Number(a.usdValue),
    })),
  })
}))

router.get('/history', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const snapshots = await prisma.walletBalanceSnapshot.findMany({
    where: { userId },
    orderBy: { capturedAt: 'desc' },
    take: 30,
    include: { assetBalances: true },
  })
  res.json(
    snapshots.map((s) => ({
      id: s.id,
      capturedAt: s.capturedAt,
      totalUsdValue: Number(s.totalUsdValue),
      assets: s.assetBalances.length,
    }))
  )
}))

export default router
