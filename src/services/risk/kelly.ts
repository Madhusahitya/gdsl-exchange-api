/**
 * Kelly criterion for position sizing.
 *
 * Full Kelly:   f* = (p·b - q) / b
 *   p = win probability (from Bayesian posterior pUp)
 *   q = 1 - p
 *   b = average win / average loss (from recent trade history)
 *
 * We apply a 0.25× safety haircut (Fractional Kelly) to stay conservative.
 *
 * Returns a fraction of total equity to risk (0 = don't trade).
 */
import { prisma } from '@cryptoflow/db'

const FRACTIONAL_KELLY = 0.25
const MIN_TRADES_FOR_KELLY = 10   // below this, use a safe default

/** Estimate win/loss ratio from last N closed trades */
async function estimateWinLossRatio(userId: string, symbol?: string, n = 100): Promise<number> {
  const trades = await prisma.trade.findMany({
    where: {
      userId,
      status: 'CLOSED',
      pnl: { not: null },
      ...(symbol ? { pair: symbol } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: n,
    select: { pnl: true },
  })

  if (trades.length < MIN_TRADES_FOR_KELLY) return 1.5  // conservative default

  const wins  = trades.filter((t) => Number(t.pnl) > 0).map((t) => Number(t.pnl))
  const losses = trades.filter((t) => Number(t.pnl) < 0).map((t) => Math.abs(Number(t.pnl)))

  if (wins.length === 0 || losses.length === 0) return 1.0

  const avgWin  = wins.reduce((a, b) => a + b, 0) / wins.length
  const avgLoss = losses.reduce((a, b) => a + b, 0) / losses.length

  return avgLoss === 0 ? 1.5 : avgWin / avgLoss
}

/**
 * Compute the fraction of equity to allocate.
 * @param pUp   Posterior probability of up move (from Bayesian ensemble)
 * @param userId For pulling historical win/loss ratio
 * @param symbol Optional — filter win/loss ratio by symbol
 */
export async function kellyFraction(
  pUp: number,
  userId: string,
  symbol?: string,
): Promise<number> {
  const p = pUp
  const q = 1 - p
  const b = await estimateWinLossRatio(userId, symbol)

  const fullKelly = (p * b - q) / b
  const fraction  = FRACTIONAL_KELLY * fullKelly

  return Math.max(0, Math.min(fraction, 0.25))  // cap at 25% of equity
}

/**
 * Compute USDT order size from fractional Kelly.
 * @param equity  Account equity in USDT
 */
export async function computeOrderSize(
  pUp:    number,
  equity: number,
  userId: string,
  symbol?: string,
): Promise<number> {
  const fraction = await kellyFraction(pUp, userId, symbol)
  const rawSize  = equity * fraction

  // Minimum order constraints
  const MIN_ORDER = 0.5
  const MAX_ORDER = equity * 0.5

  if (rawSize < MIN_ORDER) return 0
  return Math.min(rawSize, MAX_ORDER)
}
