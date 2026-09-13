import { Router, Request, Response } from 'express'
import { authenticateToken } from '../middleware/authenticateToken'
import { asyncHandler } from '../middleware/asyncHandler'
import { env } from '../lib/env'
import { logger } from '../lib/logger'
import {
  ALL_CATEGORIES,
  consumeLinkCode,
  createLinkCode,
  disconnectChat,
  disconnectUser,
  escapeMd,
  getLinkForChat,
  getLinksForUser,
  getLinkForUser,
  MAX_TELEGRAM_LINKS_PER_USER,
  sendRawMessage,
  telegramService,
  updatePrefs,
  type TelegramAlertCategory,
  type TelegramPrefs,
} from '../services/notifications/telegramService'
import { prisma } from '@cryptoflow/db'
import { liveTradingBot } from '../services/bot/liveTradingBot'

const router = Router()

/* ----------------------------------------------------------------- */
/* Webhook (Telegram → us). NOTE: registered BEFORE auth middleware. */
/* ----------------------------------------------------------------- */

router.post(
  '/webhook',
  asyncHandler(async (req: Request, res: Response) => {
    if (!telegramService.isConfigured()) {
      res.status(503).json({ ok: false, error: 'telegram_not_configured' })
      return
    }
    const expected = env.TELEGRAM_WEBHOOK_SECRET
    if (expected) {
      const provided = req.header('x-telegram-bot-api-secret-token')
      if (provided !== expected) {
        res.status(401).json({ ok: false, error: 'invalid_webhook_secret' })
        return
      }
    }

    type TgUser = { id: number; username?: string; first_name?: string }
    type TgMessage = {
      message_id: number
      from?: TgUser
      chat: { id: number; type?: string }
      date: number
      text?: string
    }
    const update = (req.body ?? {}) as { message?: TgMessage; callback_query?: unknown }
    const message = update.message
    if (!message || !message.chat?.id || !message.text) {
      res.json({ ok: true })
      return
    }

    const chatId = String(message.chat.id)
    const text = message.text.trim()

    // /start <code>  →  link an account
    const startMatch = text.match(/^\/start(?:@\S+)?\s+([A-Za-z0-9]+)\b/)
    if (startMatch) {
      const code = startMatch[1].toUpperCase()
      const result = await consumeLinkCode(code, {
        id: chatId,
        username: message.from?.username,
        firstName: message.from?.first_name,
      })
      if (result.ok) {
        await sendRawMessage(
          chatId,
          [
            '✅ *Telegram linked successfully\\.*',
            '',
            'You will now receive live trading alerts from CryptoFlow:',
            '• Trade opens & closes',
            '• Bot start / stop / emergency halts',
            '• Capital protection events',
            '• Daily P&L recap',
            '',
            'Type /help for commands\\.',
          ].join('\n'),
          { parseMode: 'MarkdownV2' },
        )
      } else {
        const reasonMessage =
          result.reason === 'code_expired'
            ? 'That link code has expired. Generate a fresh code in Settings → Telegram and try again.'
            : result.reason === 'code_already_used'
              ? 'That link code was already used. Generate a fresh code in Settings → Telegram.'
              : result.reason === 'max_links_reached'
                ? `This account already has ${MAX_TELEGRAM_LINKS_PER_USER} Telegram chats linked. Disconnect one in Settings first.`
                : result.reason === 'chat_linked_other_account'
                  ? 'This Telegram chat is linked to a different Godslandx account.'
                  : 'Could not link this chat to a Godslandx account.'
        await sendRawMessage(chatId, reasonMessage)
      }
      res.json({ ok: true })
      return
    }

    // Plain /start (no code)
    if (/^\/start(?:@\S+)?\s*$/.test(text)) {
      await sendRawMessage(
        chatId,
        [
          '👋 Welcome to *CryptoFlow Trading Alerts*\\.',
          '',
          'To link your account, open the CryptoFlow web app, go to *Settings → Telegram*, click *Connect Telegram*, and send me the command shown there \\(e\\.g\\. `/start ABC123XY`\\)\\.',
        ].join('\n'),
        { parseMode: 'MarkdownV2' },
      )
      res.json({ ok: true })
      return
    }

    const link = await getLinkForChat(chatId)
    if (!link) {
      await sendRawMessage(
        chatId,
        'This chat is not linked to a CryptoFlow account yet. Generate a link code in Settings → Telegram and send me /start <code>.',
      )
      res.json({ ok: true })
      return
    }
    const userId = link.userId

    // /help
    if (/^\/help(?:@\S+)?\s*$/.test(text)) {
      await sendRawMessage(
        chatId,
        [
          '*CryptoFlow bot commands*',
          '/status — current bot session and open positions',
          '/pnl — realized PnL today',
          '/stop — emergency-stop the live trading bot',
          '/disconnect — unlink this Telegram chat',
          '/help — this message',
        ].join('\n'),
        { parseMode: 'MarkdownV2' },
      )
      res.json({ ok: true })
      return
    }

    // /status
    if (/^\/status(?:@\S+)?\s*$/.test(text)) {
      const [session, openPositions, portfolio] = await Promise.all([
        prisma.botSession.findFirst({
          where: { userId, isActive: true },
          orderBy: { startedAt: 'desc' },
        }),
        prisma.strategyPosition.findMany({
          where: { userId, quantity: { gt: 0 } },
          select: { id: true },
        }),
        prisma.portfolio.findUnique({ where: { userId } }),
      ])
      const portfolioVal = Number(portfolio?.totalValue ?? 0)
      const lines = [
        `*Bot:* ${session ? '🟢 active' : '⚪ idle'}`,
        `*Equity:* ${escapeMd(portfolioVal.toFixed(2))}`,
        `*Open positions:* ${escapeMd(openPositions.length)}`,
      ]
      if (session) {
        lines.push(`*Started:* ${escapeMd(session.startedAt.toISOString())}`)
      }
      await sendRawMessage(chatId, lines.join('\n'), { parseMode: 'MarkdownV2' })
      res.json({ ok: true })
      return
    }

    // /pnl
    if (/^\/pnl(?:@\S+)?\s*$/.test(text)) {
      const since = new Date()
      since.setUTCHours(0, 0, 0, 0)
      const closed = await prisma.trade.findMany({
        where: { userId, status: 'CLOSED', createdAt: { gte: since }, pnl: { not: null } },
        select: { pnl: true },
      })
      const totalPnl = closed.reduce((a, t) => a + Number(t.pnl ?? 0), 0)
      const wins = closed.filter((t) => Number(t.pnl ?? 0) > 0).length
      await sendRawMessage(
        chatId,
        [
          "*Today's PnL*".replace(/'/g, "\\'"),
          `Total: ${escapeMd(totalPnl.toFixed(2))} USDT`,
          `Trades: ${escapeMd(closed.length)}  ·  Wins: ${escapeMd(wins)}`,
        ].join('\n'),
        { parseMode: 'MarkdownV2' },
      )
      res.json({ ok: true })
      return
    }

    // /stop
    if (/^\/stop(?:@\S+)?\s*$/.test(text)) {
      try {
        if (liveTradingBot.isRunning(userId)) {
          await liveTradingBot.stop(userId)
          await sendRawMessage(chatId, '🛑 Live trading bot stopped.')
        } else {
          await sendRawMessage(chatId, 'No active live bot session to stop.')
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to stop'
        await sendRawMessage(chatId, `Could not stop the bot: ${msg}`)
      }
      res.json({ ok: true })
      return
    }

    // /disconnect
    if (/^\/disconnect(?:@\S+)?\s*$/.test(text)) {
      await disconnectChat(chatId)
      await sendRawMessage(chatId, 'This chat has been unlinked. You will no longer receive alerts.')
      res.json({ ok: true })
      return
    }

    // Fallback
    await sendRawMessage(
      chatId,
      'Unknown command. Type /help for available commands.',
    )
    res.json({ ok: true })
  }),
)

/* ----------------------------------------------------------------- */
/* Authenticated linking + preferences API                            */
/* ----------------------------------------------------------------- */

router.use(authenticateToken)

router.get(
  '/status',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const links = await getLinksForUser(userId)
    const primary = links[0] ?? null
    const bot = await telegramService.resolveBotIdentity()
    res.json({
      configured: telegramService.isConfigured(),
      botUsername: bot.username ?? env.TELEGRAM_BOT_USERNAME ?? null,
      botVerified: bot.verified,
      botError: bot.verified ? null : (bot.error ?? 'Could not verify bot with Telegram'),
      maxLinks: MAX_TELEGRAM_LINKS_PER_USER,
      links,
      link: primary
        ? {
            id: primary.id,
            isActive: primary.isActive,
            username: primary.username,
            firstName: primary.firstName,
            linkedAt: primary.linkedAt,
            prefs: primary.prefs,
          }
        : null,
      categories: ALL_CATEGORIES,
    })
  }),
)

router.post(
  '/link/start',
  asyncHandler(async (req: Request, res: Response) => {
    if (!telegramService.isConfigured()) {
      res.status(503).json({
        ok: false,
        error: 'telegram_not_configured',
        message: 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME on the API server.',
      })
      return
    }
    const userId = req.user!.userId
    const bot = await telegramService.resolveBotIdentity()
    if (!bot.verified || !bot.username) {
      res.status(503).json({
        ok: false,
        error: 'telegram_bot_unreachable',
        message:
          bot.error ??
          'Telegram bot token is invalid or the bot was deleted. Ask the operator to create a bot via @BotFather and set TELEGRAM_BOT_TOKEN + TELEGRAM_BOT_USERNAME on the API server.',
        envUsername: env.TELEGRAM_BOT_USERNAME ?? null,
      })
      return
    }
    const result = await createLinkCode(userId)
    res.json({
      ok: true,
      code: result.code,
      deepLink: result.deepLink,
      botUsername: bot.username,
      command: `/start ${result.code}`,
      expiresAt: result.expiresAt.toISOString(),
      ttlMinutes: env.TELEGRAM_LINK_CODE_TTL_MIN,
    })
  }),
)

router.post(
  '/link/disconnect',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const linkId = typeof req.body?.linkId === 'string' ? req.body.linkId : undefined
    await disconnectUser(userId, linkId)
    res.json({ ok: true })
  }),
)

router.post(
  '/preferences',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const body = (req.body ?? {}) as Partial<Record<TelegramAlertCategory, unknown>>
    const cleaned: Partial<TelegramPrefs> = {}
    for (const cat of ALL_CATEGORIES) {
      const value = body[cat.key]
      if (typeof value === 'boolean') cleaned[cat.key] = value
    }
    try {
      const prefs = await updatePrefs(userId, cleaned)
      res.json({ ok: true, prefs })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update preferences'
      res.status(400).json({ ok: false, error: msg })
    }
  }),
)

router.post(
  '/test',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const links = await getLinksForUser(userId)
    if (links.length === 0) {
      res.status(400).json({ ok: false, error: 'not_linked' })
      return
    }
    const results = await Promise.all(
      links.map((link) =>
        sendRawMessage(
          link.chatId,
          [
            '🧪 koie.fin Telegram alerts test',
            '',
            'You will receive trade opens, closes, profit skims, and stop-loss alerts here.',
            '',
            'Send /help to see commands.',
          ].join('\n'),
        ),
      ),
    )
    const ok = results.some(Boolean)
    if (!ok) {
      logger.warn(`[telegram] Test message failed for user ${userId}`)
      res.status(502).json({ ok: false, error: 'telegram_send_failed' })
      return
    }
    res.json({ ok: true })
  }),
)

export default router
