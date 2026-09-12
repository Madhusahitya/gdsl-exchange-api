import { Router, Request, Response } from 'express'
import { prisma } from '@cryptoflow/db'
import { authenticateToken } from '../middleware/authenticateToken'
import { validate } from '../middleware/validate'
import { asyncHandler } from '../middleware/asyncHandler'
import { withdrawSchema } from '../validators'

const router = Router()
const NETWORK_FEE = 2.5

router.post('/', authenticateToken, validate(withdrawSchema), asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const { amount, walletAddress, network } = (req as Request & { validated: { amount: number; walletAddress: string; network: 'ERC-20' | 'BRC-20' | 'Solana' } }).validated

  const portfolio = await prisma.portfolio.findUnique({ where: { userId } })
  if (!portfolio) {
    res.status(404).json({ error: 'Portfolio not found' })
    return
  }

  const availableBalance = Number(portfolio.totalValue)
  if (amount > availableBalance) {
    res.status(400).json({ error: 'Insufficient balance' })
    return
  }

  const [withdrawal, updatedPortfolio] = await prisma.$transaction([
    prisma.withdrawal.create({
      data: {
        userId,
        amount,
        walletAddress,
        network,
        fee: NETWORK_FEE,
        status: 'COMPLETED',
      },
    }),
    prisma.portfolio.update({ where: { userId }, data: { totalValue: { decrement: amount } } }),
  ])

  res.status(201).json({
    success: true,
    withdrawalId: withdrawal.id,
    amount,
    fee: NETWORK_FEE,
    finalAmount: amount - NETWORK_FEE,
    remainingBalance: Number(updatedPortfolio.totalValue),
  })
}))

router.get('/history', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const withdrawals = await prisma.withdrawal.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 10 })
  res.json(withdrawals.map((w) => ({ ...w, amount: Number(w.amount), fee: Number(w.fee) })))
}))

export default router
