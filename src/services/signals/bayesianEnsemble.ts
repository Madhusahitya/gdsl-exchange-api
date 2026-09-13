/**
 * Bayesian signal ensemble.
 *
 * Each signal source provides a direction (UP / DOWN / NEUTRAL).
 * We combine them using Naive Bayes in log-odds form:
 *
 *   ℓ_post = ℓ_prior + Σ_i log[ P(S_i | up) / P(S_i | down) ]
 *   P(up)  = sigmoid(ℓ_post)
 *
 * Per-source likelihoods P(S | up) and P(S | down) are stored in the
 * BayesPrior table as Beta distribution parameters (alpha, beta), updated
 * online as outcomes are revealed.
 */
import { prisma } from '@cryptoflow/db'
import { logger } from '../../lib/logger'
import { emaSignal }            from './sources/emaSignal'
import { rsiSignal }            from './sources/rsiSignal'
import { macdSignal }           from './sources/macdSignal'
import { bollingerSignal }      from './sources/bollingerSignal'
import { volumeSignal }         from './sources/volumeSignal'
import { newsSentimentSignal }  from './sources/newsSentimentSignal'
import { orderBookSignal }      from './sources/orderBookSignal'

export type Direction = 'UP' | 'DOWN' | 'NEUTRAL'

export interface EnsembleResult {
  pUp:      number            // posterior P(up)
  direction: Direction
  components: Record<string, { direction: Direction; logOddsContrib: number }>
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

/** Mean of a Beta(α,β) distribution */
function betaMean(alpha: number, beta: number): number {
  return alpha / (alpha + beta)
}

/** Get or create the Beta prior for a given signal source */
async function getPrior(source: string, symbol: string, interval: string) {
  return prisma.bayesPrior.upsert({
    where: { signalSource_symbol_interval: { signalSource: source, symbol, interval } },
    create: { signalSource: source, symbol, interval },
    update: {},
  })
}

/**
 * Compute log-odds contribution for one signal direction.
 * P(S=UP | up) ≈ betaMean(alphaUp, betaUp)
 * P(S=UP | down) ≈ 1 - betaMean(alphaDown, betaDown)
 */
function logOddsContrib(
  signalDir: Direction,
  pBullishGivenUp:   number,
  pBullishGivenDown: number,
): number {
  const eps = 1e-6
  if (signalDir === 'NEUTRAL') return 0

  if (signalDir === 'UP') {
    return Math.log((pBullishGivenUp + eps) / (pBullishGivenDown + eps))
  } else {
    // SELL signal: P(S=DOWN | up) = 1 - P(S=UP | up)
    return Math.log(
      (1 - pBullishGivenUp + eps) / (1 - pBullishGivenDown + eps)
    )
  }
}

export async function runBayesianEnsemble(
  symbol: string,
  interval: string,
): Promise<EnsembleResult> {
  // Gather all signal sources
  const sources: Array<{ name: string; fn: () => Promise<Direction> }> = [
    { name: 'ema',        fn: () => emaSignal(symbol, interval) },
    { name: 'rsi',        fn: () => rsiSignal(symbol, interval) },
    { name: 'macd',       fn: () => macdSignal(symbol, interval) },
    { name: 'bollinger',  fn: () => bollingerSignal(symbol, interval) },
    { name: 'volume',     fn: () => volumeSignal(symbol, interval) },
    { name: 'news',       fn: () => newsSentimentSignal(symbol) },
    { name: 'orderbook',  fn: () => orderBookSignal(symbol) },
  ]

  // Collect each source's contribution independently, then reduce — avoids
  // the race condition where concurrent microtask continuations would interleave
  // writes to a shared `logOdds` variable.
  const results = await Promise.all(
    sources.map(async ({ name, fn }) => {
      try {
        const dir = await fn()
        const prior = await getPrior(name, symbol, interval)

        const pBullishGivenUp   = betaMean(prior.alphaUp, prior.betaUp)
        const pBullishGivenDown = betaMean(prior.alphaDown, prior.betaDown)

        const contrib = logOddsContrib(dir, pBullishGivenUp, pBullishGivenDown)
        return { name, direction: dir, contrib }
      } catch (err) {
        logger.warn({ err, name }, '[bayes] signal source error, skipping')
        return null
      }
    })
  )

  // Flat prior: P(up) = 0.5 → log-odds = 0
  const components: EnsembleResult['components'] = {}
  const logOdds = results.reduce((sum, r) => {
    if (!r) return sum
    components[r.name] = { direction: r.direction, logOddsContrib: r.contrib }
    return sum + r.contrib
  }, 0)

  const pUp = sigmoid(logOdds)
  const direction: Direction = pUp > 0.60 ? 'UP' : pUp < 0.40 ? 'DOWN' : 'NEUTRAL'

  return { pUp, direction, components }
}

/**
 * Update Beta priors once the outcome of a signal is known.
 * Call this after a trade closes: actualUp = true if price went up.
 */
export async function updatePriors(
  symbol:   string,
  interval: string,
  signals:  Record<string, Direction>,
  actualUp: boolean,
) {
  await Promise.all(
    Object.entries(signals).map(async ([source, dir]) => {
      if (dir === 'NEUTRAL') return
      const wasBullish = dir === 'UP'

      await prisma.bayesPrior.upsert({
        where: { signalSource_symbol_interval: { signalSource: source, symbol, interval } },
        create: { signalSource: source, symbol, interval },
        update: {
          // Update the relevant Beta distribution
          alphaUp:   wasBullish && actualUp   ? { increment: 1 } : undefined,
          betaUp:    wasBullish && !actualUp  ? { increment: 1 } : undefined,
          alphaDown: !wasBullish && !actualUp ? { increment: 1 } : undefined,
          betaDown:  !wasBullish && actualUp  ? { increment: 1 } : undefined,
        },
      })
    })
  )
}
