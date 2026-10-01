/** Liquid majors. They get a small score nudge, and win only when another token is essentially tied. */
export const TIER1_MAJOR_BASES = new Set(['SOL', 'BTC', 'ETH', 'WBTC', 'WETH'])

export function isTier1Major(baseSymbol: string): boolean {
  return TIER1_MAJOR_BASES.has(baseSymbol.trim().toUpperCase())
}

/** Small tie-break so liquid majors can match a similar alt. Not enough to outrank a clearly stronger setup. */
export const TIER1_SCORE_BONUS = 4
