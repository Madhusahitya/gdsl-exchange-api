import { Router, Request, Response } from 'express'
import { authenticateToken } from '../middleware/authenticateToken'
import { asyncHandler } from '../middleware/asyncHandler'
import {
  listInboxMessages,
  markAllInboxRead,
  markInboxRead,
  unreadInboxCount,
} from '../services/inbox/inboxService'

const router = Router()
router.use(authenticateToken)

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const take = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '40'), 10) || 40))
    const unreadOnly = req.query.unreadOnly === '1' || req.query.unreadOnly === 'true'
    const items = await listInboxMessages(userId, { take, unreadOnly })
    res.json({ items })
  }),
)

router.get(
  '/unread-count',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const count = await unreadInboxCount(userId)
    res.json({ count })
  }),
)

router.patch(
  '/:id/read',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const id = String(req.params.id ?? '')
    const ok = await markInboxRead(userId, id)
    if (!ok) {
      res.status(404).json({ error: 'Message not found' })
      return
    }
    res.json({ ok: true })
  }),
)

router.post(
  '/mark-all-read',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const updated = await markAllInboxRead(userId)
    res.json({ ok: true, updated })
  }),
)

export default router
