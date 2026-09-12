import { Router, Request, Response } from 'express'
import { prisma, DepositStatus } from '@cryptoflow/db'
import { authenticateToken } from '../middleware/authenticateToken'
import { validate } from '../middleware/validate'
import { asyncHandler } from '../middleware/asyncHandler'
import { depositSchema } from '../validators'

const router = Router()

/** Internal team funding: credits paper / CEX-sim wallet (`Portfolio.totalValue`) and records a deposit row. */
router.post('/', authenticateToken, validate(depositSchema), asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const { amount, reference } = (req as Request & { validated: { amount: number; reference?: string } }).validated

  const portfolio = await prisma.portfolio.findUnique({ where: { userId } })
  if (!portfolio) {
    res.status(404).json({ error: 'Portfolio not found' })
    return
  }

  const [deposit, updated] = await prisma.$transaction([
    prisma.deposit.create({
      data: {
        userId,
        amount,
        status: DepositStatus.COMPLETED,
        reference: reference ?? null,
      },
    }),
    prisma.portfolio.update({
      where: { userId },
      data: { totalValue: { increment: amount } },
    }),
  ])

  res.status(201).json({
    id: deposit.id,
    amount: Number(deposit.amount),
    walletBalance: Number(updated.totalValue),
  })
}))

router.get('/history', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const rows = await prisma.deposit.findMany({
    where: { userId, status: DepositStatus.COMPLETED },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  res.json(rows.map((d) => ({ ...d, amount: Number(d.amount) })))
}))

export default router
