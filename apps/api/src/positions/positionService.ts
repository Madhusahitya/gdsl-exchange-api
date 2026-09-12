import { prisma } from '@cryptoflow/db'
import { fetchBookTicker, paperExecutionSellPrice, paperUnrealizedPnlUsd } from '@cryptoflow/bot'

export interface PositionRow {
  id: string
  token: string
  pair: string
  entryPrice: number
  /** Approx. market sell (bid − slip) — what you’d get closing now */
  currentPrice: number | null
  midPrice: number | null
  pnlUsd: number | null
  pnlPct: number | null
  status: 'OPEN' | 'CLOSED'
  openedAt: string
}

export async function getOpenPositionsForUser(userId: string): Promise<PositionRow[]> {
  const open = await prisma.trade.findMany({
    where: { userId, status: 'OPEN' },
    orderBy: { createdAt: 'asc' },
  })

  const rows: PositionRow[] = []
  for (const t of open) {
    const symbol = t.pair.replace('/', '')
    const book = await fetchBookTicker(symbol)
    const markBid = book?.bid ?? null
    const mid = book?.mid ?? null
    const entry = Number(t.entryPrice)
    const alloc = t.allocationUsd !== null ? Number(t.allocationUsd) : null
    const exitMark = markBid !== null ? paperExecutionSellPrice(markBid) : null
    let pnlUsd: number | null = null
    let pnlPct: number | null = null
    if (markBid !== null && entry > 0 && alloc !== null && alloc > 0) {
      pnlUsd = paperUnrealizedPnlUsd(alloc, entry, markBid)
      const costBasis = alloc
      pnlPct = costBasis !== 0 ? (pnlUsd / costBasis) * 100 : null
    }
    const token = t.pair.split('/')[0] ?? symbol
    rows.push({
      id: t.id,
      token,
      pair: t.pair,
      entryPrice: entry,
      currentPrice: exitMark,
      midPrice: mid,
      pnlUsd,
      pnlPct,
      status: 'OPEN',
      openedAt: t.createdAt.toISOString(),
    })
  }
  return rows
}
