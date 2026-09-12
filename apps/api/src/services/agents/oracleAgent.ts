/**
 * Agent 1: Oracle — news & sentiment for SOL ecosystem (PDF + LLM_trader inspiration).
 */
import { agentBus, markAgentTick } from './agentBus'
import { prisma } from '@cryptoflow/db'
import { logger } from '../../lib/logger'

const ORACLE_SYMBOL = 'SOLUSDT'
const ORACLE_INTERVAL_MS = 60_000

export type OraclePayload = {
  symbol: string
  sentimentScore: number
  catalyst: string | null
  confidence: number
  headlines: string[]
}

let oracleTimer: NodeJS.Timeout | null = null

async function oracleTick(): Promise<void> {
  try {
    const recent = await prisma.newsEvent.findMany({
      where: { symbolsMentioned: { has: 'SOL' } },
      orderBy: { publishedAt: 'desc' },
      take: 8,
      select: { title: true, sentimentScore: true },
    })
    let score = 0
    let count = 0
    const headlines: string[] = []
    for (const item of recent) {
      const s = Number(item.sentimentScore)
      if (Number.isFinite(s)) {
        score += s
        count += 1
      }
      if (item.title) headlines.push(item.title.slice(0, 120))
    }
    const avg = count > 0 ? score / count : 0
    const confidence = Math.min(1, count / 5)

    let catalyst: string | null = null
    if (avg > 0.25) catalyst = 'positive_news_flow'
    else if (avg < -0.25) catalyst = 'negative_news_flow'

    const payload: OraclePayload = {
      symbol: ORACLE_SYMBOL,
      sentimentScore: avg,
      catalyst,
      confidence,
      headlines: headlines.slice(0, 5),
    }

    agentBus.publish({
      agentId: 'oracle',
      stream: 'sentiment:update',
      payload,
      ts: Date.now(),
      ttlMs: 120_000,
    })
    markAgentTick('oracle')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    markAgentTick('oracle', msg)
    logger.warn({ err }, '[oracle] tick failed')
  }
}

export function startOracleAgent(): void {
  if (oracleTimer) return
  void oracleTick()
  oracleTimer = setInterval(() => void oracleTick(), ORACLE_INTERVAL_MS)
  logger.info('[oracle] Agent started — sentiment polling every 60s')
}

export function stopOracleAgent(): void {
  if (oracleTimer) {
    clearInterval(oracleTimer)
    oracleTimer = null
  }
}
