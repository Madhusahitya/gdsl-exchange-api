import { Router, Request, Response } from 'express'
import { authenticateToken } from '../middleware/authenticateToken'
import { validate } from '../middleware/validate'
import { asyncHandler } from '../middleware/asyncHandler'
import { supportContactSchema } from '../validators'
import { createInboxMessage } from '../services/inbox/inboxService'

const router = Router()

router.use(authenticateToken)

router.post(
  '/contact',
  validate(supportContactSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const payload = (req as Request & {
      validated: { subject: string; message: string; email?: string }
    }).validated

    const item = await createInboxMessage({
      userId,
      category: 'SYSTEM',
      title: `Support request: ${payload.subject}`,
      body: payload.message,
      metadata: {
        source: 'settings-help',
        email: payload.email ?? null,
      },
    })

    res.status(201).json({ ok: true, id: item.id })
  }),
)

export default router

