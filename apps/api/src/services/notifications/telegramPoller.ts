/**
 * telegramPoller — long-polls Telegram's /getUpdates and forwards each
 * message to our own /api/telegram/webhook endpoint. This lets developers
 * link & receive alerts on localhost without needing a public HTTPS URL
 * (Telegram only delivers webhooks to publicly reachable HTTPS hosts).
 *
 * Activate by setting TELEGRAM_POLLING_ENABLED=true in the API env.
 * Requires TELEGRAM_BOT_TOKEN. TELEGRAM_WEBHOOK_SECRET is honoured if set.
 *
 * In production prefer the proper webhook (faster, no idle bandwidth).
 */

import { env } from '../../lib/env'
import { logger } from '../../lib/logger'

const TELEGRAM_API = 'https://api.telegram.org'

let running = false
let stopRequested = false
let nextOffset = 0
const POLL_TIMEOUT_S = 25

type Update = {
  update_id: number
  message?: unknown
  callback_query?: unknown
}

function isPollingEnabled(): boolean {
  if (!env.TELEGRAM_BOT_TOKEN) return false
  const flag = process.env.TELEGRAM_POLLING_ENABLED?.trim().toLowerCase()
  return flag === '1' || flag === 'true' || flag === 'yes'
}

async function deleteWebhook(): Promise<void> {
  // Telegram won't deliver getUpdates while a webhook is registered.
  try {
    await fetch(
      `${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/deleteWebhook?drop_pending_updates=false`,
      { method: 'GET' },
    )
  } catch (err) {
    logger.warn(`[telegram-poller] deleteWebhook failed: ${(err as Error).message}`)
  }
}

async function fetchUpdates(): Promise<Update[]> {
  const url = `${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates?offset=${nextOffset}&timeout=${POLL_TIMEOUT_S}&allowed_updates=${encodeURIComponent(
    JSON.stringify(['message', 'callback_query']),
  )}`
  const r = await fetch(url, { method: 'GET' })
  if (!r.ok) {
    throw new Error(`getUpdates HTTP ${r.status}`)
  }
  const data = (await r.json()) as { ok: boolean; result?: Update[]; description?: string }
  if (!data.ok) {
    throw new Error(data.description ?? 'getUpdates returned ok=false')
  }
  return data.result ?? []
}

async function dispatchToSelfWebhook(update: Update): Promise<void> {
  const internalUrl = `http://127.0.0.1:${env.PORT}/api/telegram/webhook`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    headers['x-telegram-bot-api-secret-token'] = env.TELEGRAM_WEBHOOK_SECRET
  }
  const r = await fetch(internalUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(update),
  })
  if (!r.ok) {
    logger.warn(`[telegram-poller] self-webhook responded ${r.status} for update ${update.update_id}`)
  }
}

export async function startTelegramPolling(): Promise<void> {
  if (!isPollingEnabled()) return
  if (running) return
  running = true
  stopRequested = false

  await deleteWebhook()
  logger.info('[telegram-poller] starting long-poll loop (TELEGRAM_POLLING_ENABLED=true)')

  while (!stopRequested) {
    try {
      const updates = await fetchUpdates()
      for (const update of updates) {
        try {
          await dispatchToSelfWebhook(update)
        } catch (err) {
          logger.warn(`[telegram-poller] dispatch failed: ${(err as Error).message}`)
        }
        if (update.update_id >= nextOffset) {
          nextOffset = update.update_id + 1
        }
      }
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('409')) {
        // Conflict — webhook still registered. Strip it and retry quickly.
        logger.warn('[telegram-poller] 409 conflict — re-deleting webhook and retrying')
        await deleteWebhook()
      } else {
        logger.warn(`[telegram-poller] poll failed: ${msg}`)
      }
      await new Promise((r) => setTimeout(r, 3000))
    }
  }

  running = false
  logger.info('[telegram-poller] stopped')
}

export function stopTelegramPolling(): void {
  stopRequested = true
}

export const telegramPoller = {
  start: startTelegramPolling,
  stop: stopTelegramPolling,
  isRunning: () => running,
  isEnabled: isPollingEnabled,
}
