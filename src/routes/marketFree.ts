import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler'
import { fetchFreeMarketBundle } from '../services/freeMarketApis'

const router = Router()

/** No auth — public free feeds (rate-limit via global /api limiter) */
router.get('/', asyncHandler(async (_req, res) => {
  const data = await fetchFreeMarketBundle()
  res.json(data)
}))

export default router
