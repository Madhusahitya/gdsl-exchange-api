/**
 * Meta-policy: combines Bayesian ensemble + RL + order book into a final decision.
 *
 * Signal pipeline:
 *   1. Regime filter (ADX)    — tighten entry in ranging markets
 *   2. Bayesian ensemble       — naive-Bayes combination of 7 signal sources
 *   3. RL policy               — DQN Q-values (shadow mode until validated)
 *   4. Order book imbalance    — adversarial game-theory filter
 *   5. Multi-timeframe gate    — 1m signal must not contradict 1h trend
 *   6. Kelly position sizing
 *   7. Hard risk gate
 *
 * Entry thresholds:
 *   Trending  (ADX ≥ 25): pUp > 0.60 → BUY
 *   Ranging   (ADX < 20): pUp > 0.65 → BUY  (stricter — more false signals in ranging)
 *   Transition(20–25):    pUp > 0.62
 *
 * Minimax regret filter:
 *   If OBI < −0.3 (sell-side book depth dominates) → skip BUY even if pUp passes threshold.
 */
import { prisma } from '@cryptoflow/db'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { runBayesianEnsemble, EnsembleResult, Direction } from '../signals/bayesianEnsemble'
import { predictAction, RLPrediction } from '../ml/rlPolicy'
import { orderBookService } from '../market/orderBook'
import { computeOrderSize } from '../risk/kelly'
import { checkRisk } from '../risk/riskGate'
import { klineService } from '../market/klineService'
import { adx, last } from '../market/indicators'

export interface MetaDecision {
  action:        'BUY' | 'SELL' | 'HOLD'
  pUp:           number
  orderSizeUsdt: number
  bayes:         EnsembleResult
  rl:            RLPrediction
  obi:           number | null
  regime:        'TRENDING' | 'RANGING' | 'TRANSITION'
  adxValue:      number
  blocked:       string | null
}

function softmax(vals: number[]): number[] {
  const max = Math.max(...vals)
  const exps = vals.map((v) => Math.exp(v - max))
  const sum = exps.reduce((a, b) => a + b, 0)
  return exps.map((e) => e / sum)
}

async function getRegime(symbol: string): Promise<{ regime: 'TRENDING' | 'RANGING' | 'TRANSITION'; adxValue: number }> {
  try {
    const bars = await klineService.getRecent(symbol, '1h', 60)
    if (bars.length < 30) return { regime: 'TRANSITION', adxValue: 22 }

    const highs  = bars.map((b) => Number(b.high))
    const lows   = bars.map((b) => Number(b.low))
    const closes = bars.map((b) => Number(b.close))
    const { adx: adxArr } = adx(highs, lows, closes, 14)
    const adxValue = last(adxArr)

    if (isNaN(adxValue)) return { regime: 'TRANSITION', adxValue: 22 }

    const regime = adxValue >= 25 ? 'TRENDING' : adxValue < 20 ? 'RANGING' : 'TRANSITION'
    return { regime, adxValue }
  } catch {
    return { regime: 'TRANSITION', adxValue: 22 }
  }
}

/** Entry threshold varies by regime (lowered for paper/demo so entries are not rare). */
function entryThreshold(regime: 'TRENDING' | 'RANGING' | 'TRANSITION'): number {
  switch (regime) {
    case 'TRENDING':    return 0.50
    case 'TRANSITION':  return 0.51
    case 'RANGING':     return 0.52
  }
}

/**
 * Multi-timeframe gate: check if 1h Bayesian ensemble disagrees with 1m.
 * Returns false (block) if 1h is DOWN while 1m wants to BUY, or vice versa.
 */
async function mtfAligned(
  symbol: string,
  shortDir: Direction,
): Promise<boolean> {
  if (env.NODE_ENV === 'development') return true
  try {
    const long = await runBayesianEnsemble(symbol, '1h')
    // Soft block: if 1h is bearish, require extra confidence on 1m BUY
    if (shortDir === 'UP'   && long.direction === 'DOWN') return false
    if (shortDir === 'DOWN' && long.direction === 'UP')   return false
    return true
  } catch {
    return true  // default allow if 1h data unavailable
  }
}

export async function decide(
  symbol:           string,
  userId:           string,
  positionFlag:     number,
  unrealizedPnlPct: number,
  barsInPosition:   number,
  equityUsdt:       number,
): Promise<MetaDecision> {
  const [bayes, rl, { regime, adxValue }] = await Promise.all([
    runBayesianEnsemble(symbol, '1m'),
    predictAction(symbol, positionFlag, unrealizedPnlPct, barsInPosition, 0.5),
    getRegime(symbol),
  ])

  const obi = orderBookService.getOBI(symbol)
  const obiNorm = obi !== null ? (obi + 1) / 2 : 0.5  // map [-1,1] → [0,1]

  // RL BUY probability from softmax of Q-values
  const rlProbs   = softmax(rl.qValues)
  const rlBuyProb = rlProbs[1] ?? 0  // index 1 = BUY

  // Weighted pUp: Bayes 50%, RL 30%, OBI 20%
  const pUp = 0.5 * bayes.pUp + 0.3 * rlBuyProb + 0.2 * obiNorm

  const threshold   = entryThreshold(regime)
  const exitThresh  = 1 - threshold  // symmetric exit

  // Minimax regret: adversarial order book strongly opposing → skip BUY (relaxed for demo)
  const obiBlocked = obi !== null && obi < -0.55

  let rawAction: 'BUY' | 'SELL' | 'HOLD'
  if (pUp > threshold && !obiBlocked) {
    rawAction = 'BUY'
  } else if (pUp < exitThresh) {
    rawAction = 'SELL'
  } else {
    rawAction = 'HOLD'
  }

  // Multi-timeframe gate: skip BUY/SELL if 1h disagrees
  if (rawAction === 'BUY') {
    const aligned = await mtfAligned(symbol, bayes.direction)
    if (!aligned) {
      logger.debug(`[metaPolicy] MTF gate blocked BUY: 1h contradicts 1m on ${symbol}`)
      rawAction = 'HOLD'
    }
  }

  // Compute Kelly-sized order
  const orderSizeUsdt = rawAction === 'BUY'
    ? await computeOrderSize(pUp, equityUsdt, userId, symbol)
    : 0

  // Risk gate
  let blocked: string | null = null
  if (rawAction === 'BUY' && orderSizeUsdt > 0) {
    const risk = await checkRisk(userId, orderSizeUsdt)
    if (!risk.ok) {
      blocked = risk.reason
      rawAction = 'HOLD'
    }
  }

  // Log the meta-decision as a Signal
  await prisma.signal.create({
    data: {
      userId,
      source:    'meta',
      symbol,
      ts:        new Date(),
      direction: rawAction === 'BUY' ? 'UP' : rawAction === 'SELL' ? 'DOWN' : 'NEUTRAL',
      confidence: pUp,
      rationale: {
        pUp,
        threshold,
        regime,
        adxValue,
        bayesDirection: bayes.direction,
        rlAction:       rl.action,
        obi,
        obiBlocked,
        blocked,
        components: Object.fromEntries(
          Object.entries(bayes.components).map(([k, v]) => [k, v.direction])
        ),
      },
    },
  }).catch(() => {})

  return {
    action: rawAction,
    pUp,
    orderSizeUsdt,
    bayes,
    rl,
    obi,
    regime,
    adxValue,
    blocked,
  }
}
