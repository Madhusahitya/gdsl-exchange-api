import { Router, Request, Response } from 'express'
import { prisma } from '@cryptoflow/db'
import { asyncHandler } from '../middleware/asyncHandler'
import { logger } from '../lib/logger'
import { ensureStrategiesCatalog } from '../services/ensureStrategiesCatalog'

const router = Router()

async function listFormatted() {
  const strategies = await prisma.strategy.findMany({
    orderBy: { name: 'asc' },
  })
  return strategies.map((strategy) => ({
    id: strategy.id,
    name: strategy.name,
    description: strategy.description,
    riskLevel: strategy.riskLevel,
  }))
}

// GET /api/strategies — public catalog (reference data only). Starting the bot still requires auth.
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  try {
    let rows = await listFormatted()
    if (rows.length === 0) {
      await ensureStrategiesCatalog()
      rows = await listFormatted()
    }
    res.json(rows)
  } catch (err) {
    logger.error({ err }, '[strategies] list failed; retrying after ensure')
    try {
      await ensureStrategiesCatalog()
      res.json(await listFormatted())
    } catch (err2) {
      logger.error({ err: err2 }, '[strategies] retry failed')
      throw err2
    }
  }
}))

export default router
