import { Router, Request, Response } from 'express'
import { asyncHandler } from '../middleware/asyncHandler'
import {
  getCalcCoinPrice,
  hydrateQuickCalcCoins,
  searchCalcCoins,
} from '../services/tools/cryptoCalculatorService'

const router = Router()

router.get(
  '/calc/search',
  asyncHandler(async (req: Request, res: Response) => {
    const q = String(req.query.q ?? '').trim()
    if (q.length < 1) {
      res.json({ items: [] })
      return
    }
    const items = await searchCalcCoins(q)
    res.json({ items })
  }),
)

router.get(
  '/calc/quick',
  asyncHandler(async (_req: Request, res: Response) => {
    const items = await hydrateQuickCalcCoins()
    res.json({ items })
  }),
)

router.get(
  '/calc/price',
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.query.id ?? '').trim()
    if (!id) {
      res.status(400).json({ error: 'id required' })
      return
    }
    const usd = await getCalcCoinPrice(id)
    res.json({ id, usdPrice: usd })
  }),
)

export default router
