/**
 * Maths behind prediction-market suggestions.
 *
 * A binary market pays $1 per contract if the outcome happens, so the price in
 * dollars *is* the market's implied probability: YES at 65c means the crowd
 * thinks there is a 65% chance. An edge exists only when our own estimate of
 * that probability differs from the price by more than the spread.
 *
 * For crypto strike markets we can form that estimate independently: given
 * spot, the strike, the time left and how volatile the token actually has been
 * (from the stored candles), the probability of finishing above a level is a
 * standard lognormal calculation. This is a model, not a forecast — it assumes
 * no directional view and that future volatility resembles the past year. Both
 * assumptions are stated to the user.
 *
 * Kept free of database and network imports so it can be tested directly.
 */

/** Abramowitz & Stegun 7.1.26 error function; accurate to ~1e-7. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax)
  return sign * y
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2))
}

export type ClaimDirection = 'above' | 'below'

export type CryptoClaim = {
  /** Base asset ticker, e.g. BTC. */
  base: string
  direction: ClaimDirection
  strike: number
  /**
   * True when the market resolves if the level is touched at any point, rather
   * than only at the deadline — a materially higher probability.
   */
  isTouch: boolean
}

const NAME_TO_TICKER: Record<string, string> = {
  bitcoin: 'BTC',
  btc: 'BTC',
  ethereum: 'ETH',
  ether: 'ETH',
  eth: 'ETH',
  solana: 'SOL',
  sol: 'SOL',
  ripple: 'XRP',
  xrp: 'XRP',
  dogecoin: 'DOGE',
  doge: 'DOGE',
  cardano: 'ADA',
  ada: 'ADA',
  avalanche: 'AVAX',
  avax: 'AVAX',
  chainlink: 'LINK',
  link: 'LINK',
  polkadot: 'DOT',
  dot: 'DOT',
  litecoin: 'LTC',
  ltc: 'LTC',
  bnb: 'BNB',
  toncoin: 'TON',
  ton: 'TON',
  sui: 'SUI',
  aptos: 'APT',
  apt: 'APT',
}

const BELOW_WORDS = /\b(below|under|beneath|less than|lower than|dip|drop|fall|crash)\b|<\s*\$?\d/i
const ABOVE_WORDS = /\b(above|over|exceed|greater than|higher than|at least|hit|reach|touch|top|surpass|break)\b|>=|≥|>\s*\$?\d/i
const TOUCH_WORDS = /\b(hit|reach|touch|ever|any point|anytime|at any time|all-time high|ath)\b/i

/**
 * Extracts a price claim from a market label. Returns null whenever the wording
 * is not clearly a single-strike crypto question — showing no suggestion is far
 * better than showing a confident wrong one.
 */
export function parseCryptoClaim(text: string): CryptoClaim | null {
  if (!text) return null
  const s = text.trim()

  // Strike: "$100,000", "$100k", "100K", "$1.5M".
  const strikeMatch = s.match(/\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kKmM])?\b/)
  if (!strikeMatch) return null

  const rawNum = Number(strikeMatch[1]!.replace(/,/g, ''))
  if (!Number.isFinite(rawNum) || rawNum <= 0) return null
  const suffix = strikeMatch[2]?.toLowerCase()
  const strike = suffix === 'k' ? rawNum * 1_000 : suffix === 'm' ? rawNum * 1_000_000 : rawNum
  if (strike <= 0) return null

  // Base asset: first recognised name or ticker in the text.
  let base: string | null = null
  for (const word of s.toLowerCase().match(/[a-z]+/g) ?? []) {
    const hit = NAME_TO_TICKER[word]
    if (hit) {
      base = hit
      break
    }
  }
  if (!base) return null

  // A "below" reading only wins when no "above" wording is present, since
  // "will BTC dip below 90k before hitting 120k" is ambiguous either way.
  const hasBelow = BELOW_WORDS.test(s)
  const hasAbove = ABOVE_WORDS.test(s)
  const direction: ClaimDirection = hasBelow && !hasAbove ? 'below' : 'above'

  return { base, direction, strike, isTouch: TOUCH_WORDS.test(s) }
}

export type ProbabilityInput = {
  spot: number
  strike: number
  direction: ClaimDirection
  /** Calendar days until the market closes. */
  days: number
  /** Annualised volatility in percent, e.g. 60 for 60%. */
  annualizedVolPct: number
  isTouch: boolean
}

/**
 * Probability the claim resolves YES under driftless lognormal dynamics.
 *
 * At-expiry markets use the standard digital formula. Touch markets use the
 * reflection principle for Brownian motion, which roughly doubles the
 * probability — ignoring that distinction is the single biggest way to
 * misprice these.
 */
export function estimateProbability(input: ProbabilityInput): number | null {
  const { spot, strike, direction, days, annualizedVolPct, isTouch } = input
  if (!(spot > 0) || !(strike > 0) || !(annualizedVolPct > 0)) return null
  if (!(days > 0)) {
    // Already settled in all but name: it either is or is not above the strike.
    return direction === 'above' ? (spot >= strike ? 1 : 0) : spot <= strike ? 1 : 0
  }

  const t = days / 365
  const sigma = annualizedVolPct / 100
  const vol = sigma * Math.sqrt(t)
  if (!(vol > 0)) return null

  // Already through the level, and touching is enough.
  if (isTouch) {
    if (direction === 'above' && spot >= strike) return 1
    if (direction === 'below' && spot <= strike) return 1
  }

  const logDist = Math.log(strike / spot)

  if (isTouch) {
    // P(max exceeds barrier) = 2 * P(end beyond barrier) for driftless BM.
    const p = 2 * normalCdf(-Math.abs(logDist) / vol)
    return Math.min(1, Math.max(0, p))
  }

  // Zero expected simple return puts -sigma^2*t/2 drift on the log price.
  const z = (logDist + (sigma * sigma * t) / 2) / vol
  const pAbove = normalCdf(-z)
  const p = direction === 'above' ? pAbove : 1 - pAbove
  return Math.min(1, Math.max(0, p))
}

/** Micro-USD price (1_000_000 = $1) as a probability in 0..1. */
export function impliedProbability(microUsd: number | null | undefined): number | null {
  if (microUsd == null || !Number.isFinite(microUsd)) return null
  const p = microUsd / 1_000_000
  return p > 0 && p < 1 ? p : null
}

/**
 * Expected profit per $1 staked, given our probability and the contract price.
 * A $1 stake buys 1/price contracts, each paying $1 on a win.
 */
export function expectedValuePerDollar(prob: number, price: number): number | null {
  if (!(price > 0) || !(price < 1)) return null
  if (!(prob >= 0) || !(prob <= 1)) return null
  return prob / price - 1
}

export type SideSuggestion = {
  side: 'YES' | 'NO'
  price: number
  impliedProb: number
  ourProb: number
  /** Our probability minus the market's, in percentage points. */
  edgePct: number
  /** Expected profit per $1 staked, as a fraction. */
  evPerDollar: number
}

export type EdgeVerdict = {
  action: 'BUY_YES' | 'BUY_NO' | 'SKIP'
  best: SideSuggestion | null
  reasons: string[]
  cautions: string[]
}

export type EdgeInput = {
  yesPriceMicro: number | null
  noPriceMicro: number | null
  ourProbYes: number | null
  /** Traded volume on this market, used to avoid untradeable exits. */
  volumeUsd?: number | null
  days: number | null
}

/** Minimum expected profit per dollar before a side is worth suggesting. */
const MIN_EV = 0.08
/** Minimum probability gap, so noise in the vol estimate cannot trigger a bet. */
const MIN_EDGE_PCT = 7
/** Thin books cannot be exited; Polymarket exit liquidity is a known pain point. */
const MIN_VOLUME_USD = 5_000

/**
 * Picks the side worth backing, if any. Deliberately conservative: it requires
 * a real probability gap, a real expected value, and a book deep enough to exit.
 */
export function judgeEdge(input: EdgeInput): EdgeVerdict {
  const reasons: string[] = []
  const cautions: string[] = []

  const yesPrice = impliedProbability(input.yesPriceMicro)
  const noPrice = impliedProbability(input.noPriceMicro)
  if (yesPrice == null || noPrice == null) {
    return { action: 'SKIP', best: null, reasons, cautions: ['No two-sided price on this market yet.'] }
  }

  // YES + NO should sum to about $1; a wide sum is the venue's spread and comes
  // straight out of any profit.
  const bookCost = (yesPrice + noPrice - 1) * 100
  if (bookCost > 6) {
    cautions.push(`Spread costs ${bookCost.toFixed(1)}c per contract — that comes out of any edge.`)
  }

  if (input.ourProbYes == null) {
    return {
      action: 'SKIP',
      best: null,
      reasons,
      cautions: [
        ...cautions,
        'No model estimate for this market, so there is no measurable edge — trade it on your own view.',
      ],
    }
  }

  const ourYes = input.ourProbYes
  const sides: SideSuggestion[] = []
  const evYes = expectedValuePerDollar(ourYes, yesPrice)
  const evNo = expectedValuePerDollar(1 - ourYes, noPrice)
  if (evYes != null) {
    sides.push({
      side: 'YES',
      price: yesPrice,
      impliedProb: yesPrice,
      ourProb: ourYes,
      edgePct: (ourYes - yesPrice) * 100,
      evPerDollar: evYes,
    })
  }
  if (evNo != null) {
    sides.push({
      side: 'NO',
      price: noPrice,
      impliedProb: noPrice,
      ourProb: 1 - ourYes,
      edgePct: (1 - ourYes - noPrice) * 100,
      evPerDollar: evNo,
    })
  }
  if (sides.length === 0) {
    return { action: 'SKIP', best: null, reasons, cautions: [...cautions, 'Prices are outside a tradable range.'] }
  }

  sides.sort((a, b) => b.evPerDollar - a.evPerDollar)
  const best = sides[0]!

  if ((input.volumeUsd ?? 0) < MIN_VOLUME_USD) {
    cautions.push(
      `Only $${Math.round(input.volumeUsd ?? 0).toLocaleString()} traded here — you may not be able to sell before settlement.`,
    )
  }
  if (input.days != null && input.days > 365) {
    cautions.push('More than a year to settlement — your money is tied up for a long time.')
  }

  const qualifies =
    best.evPerDollar >= MIN_EV &&
    best.edgePct >= MIN_EDGE_PCT &&
    (input.volumeUsd ?? 0) >= MIN_VOLUME_USD

  if (!qualifies) {
    if (best.edgePct < MIN_EDGE_PCT) {
      reasons.push(
        `Market is priced close to our own estimate (${(best.impliedProb * 100).toFixed(0)}% vs ${(
          best.ourProb * 100
        ).toFixed(0)}%), so there is no edge worth paying the spread for.`,
      )
    }
    return { action: 'SKIP', best, reasons, cautions }
  }

  reasons.push(
    `Market prices ${best.side} at ${(best.price * 100).toFixed(0)}c (${(best.impliedProb * 100).toFixed(
      0,
    )}% chance) while our volatility model says ${(best.ourProb * 100).toFixed(0)}%.`,
  )
  reasons.push(
    `That is a ${best.edgePct.toFixed(0)} point edge, worth about ${(best.evPerDollar * 100).toFixed(
      0,
    )}c of expected profit per $1 staked.`,
  )

  return { action: best.side === 'YES' ? 'BUY_YES' : 'BUY_NO', best, reasons, cautions }
}

/** What a stake actually buys, for the "you risk X to win Y" line. */
export function stakeBreakdown(
  stakeUsd: number,
  priceUsd: number,
): { contracts: number; maxPayout: number; maxProfit: number; breakEvenProb: number } | null {
  if (!(stakeUsd > 0) || !(priceUsd > 0) || !(priceUsd < 1)) return null
  const contracts = stakeUsd / priceUsd
  const maxPayout = contracts
  return {
    contracts,
    maxPayout,
    maxProfit: maxPayout - stakeUsd,
    // You need at least this probability for the bet to be worth taking.
    breakEvenProb: priceUsd,
  }
}
