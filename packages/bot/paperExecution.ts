import { prisma } from '@cryptoflow/db'
import { appendTradingLog } from './tradingLog'
import { getPaperAssumedSlippageBps, getPaperTakerFeeBps, paperExecutionBuyPrice, paperExecutionSellPrice, paperRoundTripPnl } from './paperRealism'

export async function paperOpenPosition(input: {
  userId: string
  strategyId: string
  pair: string
  /** Top-of-book ask (touch); execution price applies slippage + fees in PnL math */
  entryAsk: number
  allocationUsd: number
  execMeta?: Record<string, unknown>
}): Promise<{ id: string; executionPrice: number }> {
  const executionPrice = paperExecutionBuyPrice(input.entryAsk)
  const trade = await prisma.trade.create({
    data: {
      userId: input.userId,
      strategyId: input.strategyId,
      pair: input.pair,
      entryPrice: executionPrice,
      status: 'OPEN',
      allocationUsd: input.allocationUsd,
    },
  })
  const executedAt = new Date().toISOString()
  await appendTradingLog(
    input.userId,
    'EXEC',
    `OPEN ${input.pair} exec ${executionPrice.toFixed(6)} (ask ${input.entryAsk.toFixed(6)} + ${getPaperAssumedSlippageBps()} bps slip) alloc $${input.allocationUsd.toFixed(2)}`,
    {
      tradeId: trade.id,
      pair: input.pair,
      tradeSide: 'BUY',
      allocationUsd: input.allocationUsd,
      executionPrice,
      topOfBookAsk: input.entryAsk,
      feeBps: getPaperTakerFeeBps(),
      slipBps: getPaperAssumedSlippageBps(),
      executedAt,
      venue: 'PAPER_SPOT',
      chainGasUsd: null,
      chainGasNote: 'Paper spot: no on-chain gas. Costs = modeled taker fees + bid/ask slippage.',
      ...(input.execMeta ?? {}),
    }
  )
  return { id: trade.id, executionPrice }
}

export async function paperClosePosition(input: {
  userId: string
  tradeId: string
  /** Top-of-book bid (touch); exit fill applies slippage + fees in PnL math */
  exitBid: number
  execMeta?: Record<string, unknown>
}): Promise<number | null> {
  const t = await prisma.trade.findFirst({
    where: { id: input.tradeId, userId: input.userId, status: 'OPEN' },
  })
  if (!t) return null

  const entryExec = Number(t.entryPrice)
  const exitExec = paperExecutionSellPrice(input.exitBid)
  const alloc = t.allocationUsd !== null ? Number(t.allocationUsd) : 0
  const pnl =
    alloc > 0 && entryExec > 0 ? paperRoundTripPnl(alloc, entryExec, exitExec) : exitExec - entryExec

  await prisma.trade.update({
    where: { id: t.id },
    data: {
      exitPrice: exitExec,
      pnl,
      status: 'CLOSED',
    },
  })

  await prisma.portfolio.update({
    where: { userId: input.userId },
    data: {
      pnl: { increment: pnl },
      totalValue: { increment: pnl },
    },
  })

  const executedAt = new Date().toISOString()
  await appendTradingLog(
    input.userId,
    'EXEC',
    `CLOSE ${t.id} exec ${exitExec.toFixed(6)} (bid ${input.exitBid.toFixed(6)} − ${getPaperAssumedSlippageBps()} bps slip) net PnL $${pnl.toFixed(4)} (incl. ${getPaperTakerFeeBps()} bps taker / leg)`,
    {
      tradeId: t.id,
      pair: t.pair,
      tradeSide: 'SELL',
      pnl,
      exitExecutionPrice: exitExec,
      topOfBookBid: input.exitBid,
      feeBps: getPaperTakerFeeBps(),
      slipBps: getPaperAssumedSlippageBps(),
      executedAt,
      venue: 'PAPER_SPOT',
      chainGasUsd: null,
      chainGasNote: 'Paper spot: no on-chain gas. Costs = modeled taker fees + bid/ask slippage.',
      ...(input.execMeta ?? {}),
    }
  )
  return pnl
}
