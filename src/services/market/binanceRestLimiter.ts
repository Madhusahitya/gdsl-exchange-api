/**
 * Weight-aware gate for Binance spot REST calls made by background jobs.
 *
 * Binance allows 6000 request-weight per minute per IP. Background candle
 * ingestion deliberately budgets only a fraction of that so interactive paths
 * (order books, market board, live order placement) keep their headroom.
 */

const WINDOW_MS = 60_000

type Charge = { at: number; weight: number }

export class BinanceRestLimiter {
  private charges: Charge[] = []
  private readonly budget: number

  constructor(budgetPerMinute: number) {
    this.budget = Math.max(60, Math.floor(budgetPerMinute))
  }

  private usedWeight(now: number): number {
    this.charges = this.charges.filter((c) => now - c.at < WINDOW_MS)
    let total = 0
    for (const c of this.charges) total += c.weight
    return total
  }

  /** Resolves once the call fits inside the remaining minute budget. */
  async acquire(weight: number): Promise<void> {
    const cost = Math.min(this.budget, Math.max(1, Math.floor(weight)))
    for (;;) {
      const now = Date.now()
      if (this.usedWeight(now) + cost <= this.budget) {
        this.charges.push({ at: now, weight: cost })
        return
      }
      const oldest = this.charges[0]
      const waitMs = oldest ? Math.max(100, WINDOW_MS - (now - oldest.at)) : 1_000
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  }

  snapshot(): { usedWeight: number; budget: number } {
    return { usedWeight: this.usedWeight(Date.now()), budget: this.budget }
  }
}

/** Request weight for GET /api/v3/klines, which scales with the requested limit. */
export function klineRequestWeight(limit: number): number {
  if (limit <= 100) return 2
  if (limit <= 500) return 4
  if (limit <= 1000) return 6
  return 10
}
