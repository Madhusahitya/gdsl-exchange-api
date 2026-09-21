/**
 * Production-grade Telegram bot integration for per-user trade alerts.
 *
 * Capabilities:
 *  - Multi-tenant linking: each user gets their own chat_id stored in
 *    the TelegramLink table; codes consumed via /start <code>.
 *  - Per-chat rate-limit queue (Telegram allows ~1 msg/sec per chat).
 *  - Auto-retry with exponential backoff on 429 / 5xx responses.
 *  - Per-user opt-in/out for each alert category.
 *  - Markdown V2 escaping for all dynamic strings.
 *  - Optional inline keyboards for actionable alerts.
 *
 * Environment:
 *  TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, TELEGRAM_WEBHOOK_SECRET
 */
import crypto from 'crypto'
import { prisma } from '@cryptoflow/db'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'

const TELEGRAM_API = 'https://api.telegram.org'
export const MAX_TELEGRAM_LINKS_PER_USER = 3

export type TelegramAlertCategory =
  | 'tradeOpened'
  | 'tradeClosed'
  | 'tradeFailed'
  | 'botLifecycle'
  | 'riskEvents'
  | 'advisor'
  | 'dailySummary'
  | 'marketShocks'
  | 'dexAutomation'
  | 'positionUpdates'

export type TelegramPrefs = Record<TelegramAlertCategory, boolean>

export const DEFAULT_PREFS: TelegramPrefs = {
  tradeOpened: true,
  tradeClosed: true,
  tradeFailed: true,
  botLifecycle: true,
  riskEvents: true,
  advisor: true,
  dailySummary: true,
  marketShocks: false,
  dexAutomation: true,
  positionUpdates: true,
}

export const ALL_CATEGORIES: Array<{
  key: TelegramAlertCategory
  label: string
  description: string
}> = [
  { key: 'tradeOpened', label: 'Trade opened', description: 'Sent the moment your bot or you open a position.' },
  { key: 'tradeClosed', label: 'Trade closed', description: 'PnL summary every time a position closes.' },
  { key: 'tradeFailed', label: 'Trade failed', description: 'Order rejected, balance issues, broker errors.' },
  { key: 'botLifecycle', label: 'Bot started / stopped', description: 'Includes operator pauses and emergency stops.' },
  { key: 'riskEvents', label: 'Risk events', description: 'Drawdown halts, capital protection circuit breakers.' },
  { key: 'advisor', label: 'Signal advisor', description: 'When the trade advisor blocks or downsizes a buy.' },
  { key: 'dailySummary', label: 'Daily summary', description: 'Daily P&L recap with best & worst trades.' },
  { key: 'marketShocks', label: 'Market shocks', description: 'BTC/ETH ±10% in 24h or sudden volatility spikes.' },
  {
    key: 'dexAutomation',
    label: 'Solana / Super Machine',
    description: 'Super Machine opens & closes, profit skims, stop-loss, and manual Jupiter swaps.',
  },
  {
    key: 'positionUpdates',
    label: 'Open position updates',
    description: 'Profit milestones + periodic digests for running positions, with skim nudges. Throttled — never spammy.',
  },
]

function isConfigured(): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_TOKEN.length > 0)
}

type BotIdentity = { username: string | null; verified: boolean; error?: string }

let cachedBotIdentity: { at: number; value: BotIdentity } | null = null
const BOT_IDENTITY_CACHE_MS = 5 * 60_000

/**
 * Resolve the live bot @username from Telegram getMe — env TELEGRAM_BOT_USERNAME
 * can drift after a BotFather rename and would otherwise produce dead t.me links.
 */
export async function resolveBotIdentity(): Promise<BotIdentity> {
  const fromEnv = env.TELEGRAM_BOT_USERNAME?.replace(/^@/, '') ?? null
  if (!isConfigured()) {
    return { username: fromEnv, verified: false, error: 'TELEGRAM_BOT_TOKEN not set' }
  }
  if (cachedBotIdentity && Date.now() - cachedBotIdentity.at < BOT_IDENTITY_CACHE_MS) {
    return cachedBotIdentity.value
  }
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/getMe`, {
      signal: AbortSignal.timeout(8_000),
    })
    const json = (await res.json()) as {
      ok?: boolean
      description?: string
      result?: { username?: string; is_bot?: boolean }
    }
    if (json.ok && json.result?.username) {
      const value: BotIdentity = { username: json.result.username, verified: true }
      cachedBotIdentity = { at: Date.now(), value }
      if (fromEnv && fromEnv.toLowerCase() !== json.result.username.toLowerCase()) {
        logger.warn(
          `[telegram] TELEGRAM_BOT_USERNAME=${fromEnv} but getMe returned @${json.result.username} — using live username for links`,
        )
      }
      return value
    }
    const value: BotIdentity = {
      username: fromEnv,
      verified: false,
      error: json.description ?? `getMe HTTP ${res.status}`,
    }
    cachedBotIdentity = { at: Date.now(), value }
    return value
  } catch (err) {
    const value: BotIdentity = {
      username: fromEnv,
      verified: false,
      error: err instanceof Error ? err.message : 'getMe failed',
    }
    cachedBotIdentity = { at: Date.now(), value }
    return value
  }
}

/**
 * Markdown V2 requires escaping these characters in all message bodies:
 *   _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
export function escapeMd(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => `\\${m}`)
}

/* ----------------------------------------------------------------- */
/* Per-chat rate limit queue                                          */
/* ----------------------------------------------------------------- */

type QueuedMessage = {
  payload: Record<string, unknown>
  attempt: number
  resolve: (ok: boolean) => void
}

const PER_CHAT_INTERVAL_MS = 1100
const queues = new Map<string, QueuedMessage[]>()
const lastSendAt = new Map<string, number>()
const draining = new Set<string>()

async function sendNow(payload: Record<string, unknown>): Promise<{ ok: boolean; status: number; description?: string }> {
  if (!isConfigured()) return { ok: false, status: 503, description: 'TELEGRAM_BOT_TOKEN not set' }
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string }
    return { ok: Boolean(json.ok), status: res.status, description: json.description }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      description: err instanceof Error ? err.message : 'network error',
    }
  }
}

async function drain(chatId: string): Promise<void> {
  if (draining.has(chatId)) return
  draining.add(chatId)
  try {
    while (true) {
      const queue = queues.get(chatId)
      if (!queue || queue.length === 0) break
      const last = lastSendAt.get(chatId) ?? 0
      const wait = Math.max(0, PER_CHAT_INTERVAL_MS - (Date.now() - last))
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      const next = queue[0]
      const result = await sendNow(next.payload)
      lastSendAt.set(chatId, Date.now())
      if (result.ok) {
        queue.shift()
        next.resolve(true)
        continue
      }
      // Telegram returns 403 if user blocked the bot — disable link.
      if (result.status === 403) {
        await prisma.telegramLink
          .updateMany({ where: { chatId }, data: { isActive: false } })
          .catch(() => null)
        queue.shift()
        next.resolve(false)
        continue
      }
      if ((result.status === 429 || result.status >= 500) && next.attempt < 3) {
        next.attempt += 1
        const backoff = Math.min(15_000, 1500 * 2 ** (next.attempt - 1))
        await new Promise((r) => setTimeout(r, backoff))
        continue
      }
      logger.warn(
        `[telegram] sendMessage failed (status=${result.status}, desc=${result.description}, chatId=${chatId})`,
      )
      queue.shift()
      next.resolve(false)
    }
  } finally {
    draining.delete(chatId)
  }
}

function enqueue(chatId: string, payload: Record<string, unknown>): Promise<boolean> {
  const list = queues.get(chatId) ?? []
  return new Promise<boolean>((resolve) => {
    list.push({ payload, attempt: 0, resolve })
    queues.set(chatId, list)
    void drain(chatId)
  })
}

export async function sendRawMessage(
  chatId: string,
  text: string,
  opts: {
    parseMode?: 'MarkdownV2' | 'HTML' | undefined
    disablePreview?: boolean
    replyMarkup?: Record<string, unknown>
  } = {},
): Promise<boolean> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: text.length > 4096 ? text.slice(0, 4093) + '...' : text,
    disable_web_page_preview: opts.disablePreview ?? true,
  }
  if (opts.parseMode) payload.parse_mode = opts.parseMode
  if (opts.replyMarkup) payload.reply_markup = opts.replyMarkup
  return enqueue(chatId, payload)
}

/* ----------------------------------------------------------------- */
/* Linking helpers                                                    */
/* ----------------------------------------------------------------- */

function generateCode(length = 8): string {
  // Avoid ambiguous chars (0/O, 1/I/L)
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const bytes = crypto.randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length]
  }
  return out
}

export async function createLinkCode(userId: string): Promise<{ code: string; deepLink: string | null; expiresAt: Date }> {
  const ttlMin = env.TELEGRAM_LINK_CODE_TTL_MIN
  const expiresAt = new Date(Date.now() + ttlMin * 60_000)
  // Invalidate any pre-existing unused codes for this user to keep things tidy.
  await prisma.telegramLinkCode.updateMany({
    where: { userId, consumed: false },
    data: { consumed: true },
  })
  let code = generateCode()
  // Ensure uniqueness (extremely unlikely collision).
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const exists = await prisma.telegramLinkCode.findUnique({ where: { code } })
    if (!exists) break
    code = generateCode()
  }
  await prisma.telegramLinkCode.create({
    data: { code, userId, expiresAt },
  })
  const bot = await resolveBotIdentity()
  const deepLink = bot.username ? `https://t.me/${bot.username}?start=${code}` : null
  return { code, deepLink, expiresAt }
}

export async function consumeLinkCode(
  code: string,
  chat: { id: string; username?: string; firstName?: string },
): Promise<{ ok: boolean; userId?: string; reason?: string }> {
  const row = await prisma.telegramLinkCode.findUnique({ where: { code } })
  if (!row) return { ok: false, reason: 'code_not_found' }
  if (row.consumed) return { ok: false, reason: 'code_already_used' }
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'code_expired' }

  const chatId = chat.id
  const existingChat = await prisma.telegramLink.findUnique({ where: { chatId } })
  if (existingChat && existingChat.userId !== row.userId) {
    return { ok: false, reason: 'chat_linked_other_account' }
  }

  const activeCount = await prisma.telegramLink.count({
    where: { userId: row.userId, isActive: true },
  })
  if (!existingChat && activeCount >= MAX_TELEGRAM_LINKS_PER_USER) {
    return { ok: false, reason: 'max_links_reached' }
  }

  await prisma.$transaction([
    prisma.telegramLinkCode.update({
      where: { code },
      data: { consumed: true },
    }),
    existingChat
      ? prisma.telegramLink.update({
          where: { id: existingChat.id },
          data: {
            chatId,
            username: chat.username ?? null,
            firstName: chat.firstName ?? null,
            isActive: true,
          },
        })
      : prisma.telegramLink.create({
          data: {
            userId: row.userId,
            chatId,
            username: chat.username ?? null,
            firstName: chat.firstName ?? null,
            prefs: DEFAULT_PREFS,
          },
        }),
  ])
  return { ok: true, userId: row.userId }
}

export async function disconnectUser(userId: string, linkId?: string): Promise<void> {
  if (linkId) {
    await prisma.telegramLink.updateMany({
      where: { id: linkId, userId },
      data: { isActive: false },
    })
    return
  }
  await prisma.telegramLink.updateMany({ where: { userId }, data: { isActive: false } })
}

export async function disconnectChat(chatId: string): Promise<void> {
  await prisma.telegramLink.updateMany({ where: { chatId }, data: { isActive: false } })
}

export async function getLinksForUser(userId: string) {
  const rows = await prisma.telegramLink.findMany({
    where: { userId, isActive: true },
    orderBy: { linkedAt: 'asc' },
    take: MAX_TELEGRAM_LINKS_PER_USER,
  })
  return rows.map((row) => ({
    id: row.id,
    chatId: row.chatId,
    username: row.username,
    firstName: row.firstName,
    isActive: row.isActive,
    prefs: { ...DEFAULT_PREFS, ...((row.prefs as Partial<TelegramPrefs> | null) ?? {}) } as TelegramPrefs,
    linkedAt: row.linkedAt,
  }))
}

export async function getLinkForUser(userId: string) {
  const links = await getLinksForUser(userId)
  return links[0] ?? null
}

export async function getLinkForChat(chatId: string) {
  const row = await prisma.telegramLink.findFirst({ where: { chatId, isActive: true } })
  return row
}

export async function updatePrefs(userId: string, partial: Partial<TelegramPrefs>): Promise<TelegramPrefs> {
  const links = await getLinksForUser(userId)
  if (links.length === 0) throw new Error('No active Telegram link')
  const next = {
    ...DEFAULT_PREFS,
    ...links[0].prefs,
    ...partial,
  } as TelegramPrefs
  await prisma.telegramLink.updateMany({
    where: { userId, isActive: true },
    data: { prefs: next },
  })
  return next
}

/* ----------------------------------------------------------------- */
/* Outbound alert API                                                 */
/* ----------------------------------------------------------------- */

async function sendToUser(
  userId: string,
  text: string,
  opts: { category?: TelegramAlertCategory; replyMarkup?: Record<string, unknown> } = {},
): Promise<boolean> {
  const links = await getLinksForUser(userId)
  if (links.length === 0) return false
  const eligible = links.filter((link) => !opts.category || link.prefs[opts.category] !== false)
  if (eligible.length === 0) return false
  const results = await Promise.all(
    eligible.map((link) =>
      sendRawMessage(link.chatId, text, {
        parseMode: 'MarkdownV2',
        replyMarkup: opts.replyMarkup,
      }),
    ),
  )
  return results.some(Boolean)
}

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  return `$${n.toFixed(2)}`
}

function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (n >= 1) return n.toFixed(2)
  return n.toFixed(6)
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

export async function notifyTradeOpened(input: {
  userId: string
  symbol: string
  side: 'BUY' | 'SELL'
  entryPrice: number
  notionalUsdt: number
  source: 'live-bot' | 'manual' | 'dex'
}): Promise<boolean> {
  const lines = [
    `🟢 *${escapeMd(input.side === 'BUY' ? 'Trade opened' : 'Position closed')}*`,
    `Pair: \`${escapeMd(input.symbol)}\``,
    `Side: \`${escapeMd(input.side)}\``,
    `Size: \`${escapeMd(fmtUsd(input.notionalUsdt))}\``,
    `Entry: \`${escapeMd(fmtPrice(input.entryPrice))}\``,
    `Source: \`${escapeMd(input.source)}\``,
    `Time: \`${escapeMd(new Date().toISOString())}\``,
  ]
  return sendToUser(input.userId, lines.join('\n'), { category: 'tradeOpened' })
}

export async function notifyTradeClosed(input: {
  userId: string
  symbol: string
  exitPrice: number
  pnlUsdt: number | null
  pnlPct: number | null
  durationSecs?: number | null
}): Promise<boolean> {
  const positive = (input.pnlUsdt ?? 0) >= 0
  const heart = positive ? '✅' : '🔻'
  const lines = [
    `${heart} *Trade closed*`,
    `Pair: \`${escapeMd(input.symbol)}\``,
    `Exit: \`${escapeMd(fmtPrice(input.exitPrice))}\``,
    `PnL: \`${escapeMd(fmtUsd(input.pnlUsdt))} (${fmtPct(input.pnlPct)})\``,
  ]
  if (input.durationSecs != null) {
    lines.push(`Duration: \`${escapeMd(formatDuration(input.durationSecs))}\``)
  }
  return sendToUser(input.userId, lines.join('\n'), { category: 'tradeClosed' })
}

export async function notifyTradeFailed(input: {
  userId: string
  symbol?: string
  side?: string
  errorType: string
  message: string
}): Promise<boolean> {
  const lines = [
    `⚠️ *Trade failed*`,
    input.symbol ? `Pair: \`${escapeMd(input.symbol)}\`` : null,
    input.side ? `Side: \`${escapeMd(input.side)}\`` : null,
    `Reason: \`${escapeMd(input.errorType)}\``,
    `Detail: ${escapeMd(input.message)}`,
  ].filter(Boolean) as string[]
  return sendToUser(input.userId, lines.join('\n'), { category: 'tradeFailed' })
}

export async function notifyBotLifecycle(input: {
  userId: string
  event: 'started' | 'stopped' | 'emergency_stop'
  detail?: string
}): Promise<boolean> {
  const icons: Record<typeof input.event, string> = {
    started: '🚀',
    stopped: '🛑',
    emergency_stop: '🚨',
  }
  const labels: Record<typeof input.event, string> = {
    started: 'Auto trading started',
    stopped: 'Auto trading stopped',
    emergency_stop: 'Emergency stop fired',
  }
  const lines = [
    `${icons[input.event]} *${escapeMd(labels[input.event])}*`,
    input.detail ? `Detail: ${escapeMd(input.detail)}` : null,
    `Time: \`${escapeMd(new Date().toISOString())}\``,
  ].filter(Boolean) as string[]
  return sendToUser(input.userId, lines.join('\n'), { category: 'botLifecycle' })
}

export async function notifyRiskEvent(input: {
  userId: string
  title: string
  detail: string
}): Promise<boolean> {
  const text = [`🛡️ *${escapeMd(input.title)}*`, escapeMd(input.detail)].join('\n')
  return sendToUser(input.userId, text, { category: 'riskEvents' })
}

export async function notifyAdvisorBlock(input: {
  userId: string
  symbol: string
  side: 'BUY' | 'SELL'
  reasons: Array<{ message: string; source: string; sourceUrl?: string }>
}): Promise<boolean> {
  const lines = [
    `🧭 *Trade blocked by signal advisor*`,
    `Pair: \`${escapeMd(input.symbol)}\``,
    `Side: \`${escapeMd(input.side)}\``,
    '',
    '*Reasons:*',
    ...input.reasons.slice(0, 5).map((r) => {
      const url = r.sourceUrl ? ` _(source: ${escapeMd(r.source)})_` : ` _(source: ${escapeMd(r.source)})_`
      return `• ${escapeMd(r.message)}${url}`
    }),
  ]
  return sendToUser(input.userId, lines.join('\n'), { category: 'advisor' })
}

/** Terminal-only activity (requires linking Telegram under Settings). */
export async function notifyDexAutomation(input: {
  userId: string
  title: string
  lines: string[]
}): Promise<boolean> {
  const text = [
    `📊 *${escapeMd(input.title)}*`,
    '',
    ...input.lines.map((line) => escapeMd(line)),
    '',
    `Time: \`${escapeMd(new Date().toISOString())}\``,
  ].join('\n')
  return sendToUser(input.userId, text, { category: 'dexAutomation' })
}

export async function notifyDexSwapExecuted(input: {
  userId: string
  walletLabel: string
  side: 'BUY' | 'SELL'
  tokenSymbol?: string
  amountIn?: string
  expectedOut?: string
  txHash: string
  trigger?: 'auto' | 'manual'
  fillPriceUsd?: number
  entryPriceUsd?: number
  usdtSpent?: number
  usdtReceived?: number
  realizedPnlUsd?: number | null
  reason?: string
}): Promise<boolean> {
  return notifyDexBotTrade({
    userId: input.userId,
    action: input.side,
    pair: input.tokenSymbol ? `${input.tokenSymbol}/USDT` : 'DEX',
    reason: input.reason,
    fillPriceUsd: input.fillPriceUsd,
    entryPriceUsd: input.entryPriceUsd,
    usdtSpent: input.usdtSpent,
    usdtReceived: input.usdtReceived,
    realizedPnlUsd: input.realizedPnlUsd,
    txHash: input.txHash,
    trigger: input.trigger,
    walletLabel: input.walletLabel,
  })
}

/**
 * Straight investor-facing alert: what the bot did, at what price, and
 * (on SELL) how much profit/loss in USDT.
 */
export async function notifyDexBotTrade(input: {
  userId: string
  action: 'BUY' | 'SELL'
  pair: string
  reason?: string
  fillPriceUsd?: number
  entryPriceUsd?: number
  usdtSpent?: number
  usdtReceived?: number
  realizedPnlUsd?: number | null
  unrealizedPct?: number
  txHash?: string
  trigger?: 'auto' | 'manual'
  walletLabel?: string
}): Promise<boolean> {
  const fmtPx = (n: number) =>
    n >= 1000 ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : `$${n.toFixed(4)}`
  const fmtUsd = (n: number) => {
    const sign = n >= 0 ? '+' : ''
    return `${sign}$${Math.abs(n).toFixed(2)}`
  }

  const headline =
    input.action === 'BUY'
      ? `🟢 *Godslandx Super Machine BUY* · ${escapeMd(input.pair)}`
      : `🔴 *Godslandx Super Machine SELL* · ${escapeMd(input.pair)}`

  const lines: string[] = []
  if (input.walletLabel) lines.push(`Bot: \`${escapeMd(input.walletLabel)}\``)
  if (input.reason) lines.push(escapeMd(input.reason))
  if (input.fillPriceUsd != null && Number.isFinite(input.fillPriceUsd)) {
    lines.push(
      input.action === 'BUY'
        ? `Buy price: \`${escapeMd(fmtPx(input.fillPriceUsd))}\``
        : `Sell price: \`${escapeMd(fmtPx(input.fillPriceUsd))}\``,
    )
  }
  if (input.action === 'SELL' && input.entryPriceUsd != null && Number.isFinite(input.entryPriceUsd)) {
    lines.push(`Entry was: \`${escapeMd(fmtPx(input.entryPriceUsd))}\``)
  }
  if (input.usdtSpent != null && input.usdtSpent > 0) {
    lines.push(`Invested: \`$${escapeMd(input.usdtSpent.toFixed(2))}\` USDC`)
  }
  if (input.usdtReceived != null && input.usdtReceived > 0) {
    lines.push(`Sold for: \`$${escapeMd(input.usdtReceived.toFixed(2))}\` USDC`)
  }
  if (
    input.action === 'SELL' &&
    input.realizedPnlUsd != null &&
    Number.isFinite(input.realizedPnlUsd)
  ) {
    const pnl = input.realizedPnlUsd
    const emoji = pnl >= 0 ? '✅' : '⚠️'
    lines.push(`${emoji} *P&L:* \`${escapeMd(fmtUsd(pnl))}\` USDC`)
  } else if (
    input.action === 'SELL' &&
    input.unrealizedPct != null &&
    Number.isFinite(input.unrealizedPct)
  ) {
    lines.push(`Move vs entry: \`${escapeMd(`${input.unrealizedPct >= 0 ? '+' : ''}${input.unrealizedPct.toFixed(2)}%`)}\``)
  }
  if (input.txHash) lines.push(`Tx: \`${escapeMd(input.txHash.slice(0, 18))}…\``)
  if (input.trigger === 'auto') lines.push('_Auto · server_')
  else if (input.trigger === 'manual') lines.push('_Manual_')

  const text = [headline, '', ...lines].join('\n')
  return sendToUser(input.userId, text, { category: 'dexAutomation' })
}

export async function notifyDailySummary(input: {
  userId: string
  totalEquityUsdt: number
  realizedPnlTodayUsdt: number
  unrealizedPnlUsdt: number
  bestTradeSymbol: string | null
  bestTradePnl: number | null
  worstTradeSymbol: string | null
  worstTradePnl: number | null
  tradesCount: number
}): Promise<boolean> {
  const lines = [
    `📊 *Daily trading recap*`,
    `Equity: \`${escapeMd(fmtUsd(input.totalEquityUsdt))}\``,
    `Realized today: \`${escapeMd(fmtUsd(input.realizedPnlTodayUsdt))}\``,
    `Unrealized: \`${escapeMd(fmtUsd(input.unrealizedPnlUsdt))}\``,
    `Trades: \`${escapeMd(input.tradesCount)}\``,
  ]
  if (input.bestTradeSymbol) {
    lines.push(
      `Best: \`${escapeMd(input.bestTradeSymbol)} ${fmtUsd(input.bestTradePnl ?? 0)}\``,
    )
  }
  if (input.worstTradeSymbol) {
    lines.push(
      `Worst: \`${escapeMd(input.worstTradeSymbol)} ${fmtUsd(input.worstTradePnl ?? 0)}\``,
    )
  }
  return sendToUser(input.userId, lines.join('\n'), { category: 'dailySummary' })
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
}

/**
 * Open-position update — profit milestone or periodic digest. Throttling lives
 * in positionUpdateService; this just renders and sends.
 */
export async function notifyPositionUpdate(input: {
  userId: string
  venue: 'Jupiter' | 'Binance'
  pair: string
  entryPrice: number
  mark: number
  pnlPct: number
  pnlUsd: number | null
  takeProfitPct: number
  stopLossPct: number
  trailingStop: boolean
  skimmedUsd?: number
  openedAt: number
  milestonePct: number | null
  digest: boolean
}): Promise<boolean> {
  const asset = input.venue === 'Jupiter' ? 'USDC' : 'USDT'
  const headline =
    input.milestonePct != null
      ? `🎯 *Profit milestone \\+${escapeMd(input.milestonePct)}% — ${escapeMd(input.pair)}*`
      : `📊 *Position update — ${escapeMd(input.pair)}*`

  const lines: string[] = [
    headline,
    `Venue: \`${escapeMd(input.venue)}\``,
    `Move vs entry: \`${escapeMd(fmtPct(input.pnlPct))}\``,
  ]
  if (input.pnlUsd != null && Number.isFinite(input.pnlUsd)) {
    lines.push(`Unrealized: \`${escapeMd(fmtUsd(input.pnlUsd))}\` ${asset}`)
  }
  lines.push(`Entry \\→ now: \`${escapeMd(fmtPrice(input.entryPrice))}\` \\→ \`${escapeMd(fmtPrice(input.mark))}\``)
  lines.push(
    `Exit plan: \`TP ${escapeMd(input.takeProfitPct)}% · SL ${escapeMd(input.stopLossPct)}%${input.trailingStop ? ' · trailing' : ''}\``,
  )
  if ((input.skimmedUsd ?? 0) > 0) {
    lines.push(`Already skimmed: \`${escapeMd(fmtUsd(input.skimmedUsd ?? 0))}\` ${asset} banked`)
  }
  if (input.digest) {
    const ageSecs = Math.max(0, Math.floor((Date.now() - input.openedAt) / 1000))
    lines.push(`Running for: \`${escapeMd(formatDuration(ageSecs))}\``)
  }
  if (input.pnlPct > 0) {
    lines.push(
      '',
      input.venue === 'Jupiter'
        ? `💡 In profit — you can *Skim* it into USDC anytime \\(Solana → Open positions\\)\\. The position keeps running toward your TP/SL\\.`
        : `💡 In profit — you can *Skim* it into USDT anytime \\(Binance → Dashboard\\)\\. The position keeps running toward your TP/SL\\.`,
    )
  }

  return sendToUser(input.userId, lines.join('\n'), { category: 'positionUpdates' })
}

export const telegramService = {
  isConfigured,
  resolveBotIdentity,
  sendRawMessage,
  sendToUser,
  createLinkCode,
  consumeLinkCode,
  disconnectUser,
  disconnectChat,
  getLinkForUser,
  getLinksForUser,
  getLinkForChat,
  updatePrefs,
  notifyTradeOpened,
  notifyTradeClosed,
  notifyTradeFailed,
  notifyBotLifecycle,
  notifyRiskEvent,
  notifyAdvisorBlock,
  notifyDailySummary,
  notifyDexAutomation,
  notifyDexSwapExecuted,
  notifyDexBotTrade,
  notifyPositionUpdate,
}
