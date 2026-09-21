/**
 * One-time alerts when a Jupiter open position crosses break-even (in profit to sell).
 */
import { SOLANA_DEX_ROUND_TRIP_FEE_USD } from '../../lib/roundTripPnl'
import { env } from '../../lib/env'
import { createInboxMessage } from '../inbox/inboxService'
import { telegramService } from '../notifications/telegramService'

const breakEvenNotified = new Set<string>()

export function clearBreakEvenAlert(tradeId: string): void {
  breakEvenNotified.delete(tradeId)
}

export async function maybeNotifyJupiterBreakEven(input: {
  tradeId: string
  userId: string
  pair: string
  baseSymbol: string
  entry: number
  exitMark: number
  estNetUsd: number
  buyAlloc: number
  slippageBps: number
}): Promise<void> {
  if (breakEvenNotified.has(input.tradeId)) return

  const slipFactor = 1 - Math.min(2000, Math.max(0, input.slippageBps)) / 10_000
  if (input.buyAlloc <= 0 || slipFactor <= 0) return
  const targetNet = env.dexMinNetProfitUsd + SOLANA_DEX_ROUND_TRIP_FEE_USD
  const breakEvenPrice = input.entry * (1 + targetNet / slipFactor / input.buyAlloc)
  const inProfit = input.exitMark >= breakEvenPrice && input.estNetUsd >= env.dexMinNetProfitUsd
  if (!inProfit) return

  breakEvenNotified.add(input.tradeId)

  const pnlStr = input.estNetUsd >= 0 ? `+$${input.estNetUsd.toFixed(2)}` : `$${input.estNetUsd.toFixed(2)}`
  const title = `${input.baseSymbol} — in profit on Jupiter`
  const body = `Live sell clears break-even. Est. net ${pnlStr} if you sell now on Jupiter (not Binance).`

  void createInboxMessage({
    userId: input.userId,
    category: 'TOKEN_TRADING_SIGNAL',
    title,
    body,
    metadata: {
      source: 'dex-jupiter',
      pair: input.pair,
      estNetUsd: input.estNetUsd,
      liveBid: input.exitMark,
      entry: input.entry,
    },
  }).catch(() => null)

  void telegramService
    .notifyDexBotTrade({
      userId: input.userId,
      action: 'SELL',
      pair: input.pair,
      reason: `Break-even cleared — selling now nets ~${pnlStr} after fees`,
      fillPriceUsd: input.exitMark,
      entryPriceUsd: input.entry,
      realizedPnlUsd: input.estNetUsd,
      trigger: 'auto',
    })
    .catch(() => null)
}
