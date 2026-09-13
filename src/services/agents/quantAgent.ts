/**
 * Agent 2: Quant — live SOL market ticks + order book imbalance.
 */
import { fetchBookTicker } from '@cryptoflow/bot'
import { agentBus, markAgentTick } from './agentBus'
import { orderBookService } from '../market/orderBook'
import { logger } from '../../lib/logger'

const QUANT_SYMBOL = 'SOLUSDT'
const QUANT_INTERVAL_MS = 15_000

export type QuantPayload = {
  symbol: string
  mid: number
  bid: number
  ask: number
  spreadBps: number
  obi: number | null
  updatedAt: string
}

let quantTimer: NodeJS.Timeout | null = null

async function quantTick(): Promise<void> {
  try {
    const book = await fetchBookTicker(QUANT_SYMBOL)
    if (!book) {
      markAgentTick('quant', 'no_book')
      return
    }

    const { bid, ask, mid } = book
    const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10_000 : 0
    const obi = orderBookService.getOBI(QUANT_SYMBOL)

    const payload: QuantPayload = {
      symbol: QUANT_SYMBOL,
      mid,
      bid,
      ask,
      spreadBps,
      obi,
      updatedAt: new Date().toISOString(),
    }

    agentBus.publish({
      agentId: 'quant',
      stream: 'market:tick',
      payload,
      ts: Date.now(),
      ttlMs: 30_000,
    })
    markAgentTick('quant')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    markAgentTick('quant', msg)
    logger.warn({ err }, '[quant] tick failed')
  }
}

export function startQuantAgent(): void {
  if (quantTimer) return
  void quantTick()
  quantTimer = setInterval(() => void quantTick(), QUANT_INTERVAL_MS)
  logger.info('[quant] Agent started — market ticks every 15s')
}

export function stopQuantAgent(): void {
  if (quantTimer) {
    clearInterval(quantTimer)
    quantTimer = null
  }
}
