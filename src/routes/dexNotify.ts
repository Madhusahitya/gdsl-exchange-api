import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { authenticateToken } from '../middleware/authenticateToken'
import { asyncHandler } from '../middleware/asyncHandler'
import { validate } from '../middleware/validate'
import {
  telegramService,
} from '../services/notifications/telegramService'

const router = Router()

const payloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('signal'),
    symbol: z.string().min(1).max(48),
    signal: z.enum(['BUY', 'SELL']),
    refPrice: z.number().finite().optional(),
    fearGreed: z.number().finite().optional(),
  }),
  z.object({
    kind: z.literal('swap_success'),
    side: z.enum(['BUY', 'SELL']),
    tokenSymbol: z.string().min(1).max(32),
    amountIn: z.string().max(96),
    expectedOut: z.string().max(96),
    txHash: z.string().min(10).max(128),
    trigger: z.enum(['auto', 'manual']).optional(),
  }),
  z.object({
    kind: z.literal('swap_failed'),
    message: z.string().min(1).max(2000),
    side: z.enum(['BUY', 'SELL']).optional(),
    tokenSymbol: z.string().max(32).optional(),
    trigger: z.enum(['auto', 'manual']).optional(),
  }),
  z.object({
    kind: z.literal('automation_pause'),
    detail: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal('automation_resume'),
    detail: z.string().max(500).optional(),
  }),
])

router.use(authenticateToken)

router.post(
  '/notify',
  validate(payloadSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const body = (req as Request & { validated: z.infer<typeof payloadSchema> }).validated

    if (body.kind === 'signal') {
      const lines = [
        `Pair: ${body.symbol}`,
        `Signal: ${body.signal}`,
        body.refPrice !== undefined ? `Ref price: ${body.refPrice}` : null,
        body.fearGreed !== undefined ? `Fear & Greed: ${body.fearGreed}` : null,
      ].filter(Boolean) as string[]
      const ok = await telegramService.notifyDexAutomation({
        userId,
        title: `DEX strategy signal · ${body.signal}`,
        lines,
      })
      res.json({ ok: true, delivered: ok })
      return
    }

    if (body.kind === 'swap_success') {
      const ok = await telegramService.notifyDexSwapExecuted({
        userId,
        walletLabel: 'Browser wallet (MetaMask / WalletConnect)',
        side: body.side,
        tokenSymbol: body.tokenSymbol,
        amountIn: body.amountIn,
        expectedOut: body.expectedOut,
        txHash: body.txHash,
        trigger: body.trigger,
      })
      res.json({ ok: true, delivered: ok })
      return
    }

    if (body.kind === 'swap_failed') {
      const ok = await telegramService.notifyTradeFailed({
        userId,
        symbol: body.tokenSymbol,
        side: body.side,
        errorType: 'dex_swap_failed',
        message:
          (body.trigger ? `[${body.trigger}] ` : '') + body.message.slice(0, 1500),
      })
      res.json({ ok: true, delivered: ok })
      return
    }

    if (body.kind === 'automation_pause') {
      const ok = await telegramService.notifyBotLifecycle({
        userId,
        event: 'stopped',
        detail: body.detail ?? 'DEX automatic trading paused from the terminal.',
      })
      res.json({ ok: true, delivered: ok })
      return
    }

    const ok = await telegramService.notifyBotLifecycle({
      userId,
      event: 'started',
      detail: body.detail ?? 'DEX automatic trading resumed from the terminal.',
    })
    res.json({ ok: true, delivered: ok })
  }),
)

export default router
