/** Tier-1 symbols the Super Machine should prefer over trending memes/alts. */
export const TIER1_MAJOR_BASES = new Set(['SOL', 'BTC', 'ETH', 'WBTC', 'WETH'])

export function isTier1Major(baseSymbol: string): boolean {
  return TIER1_MAJOR_BASES.has(baseSymbol.trim().toUpperCase())
}

/** Score bonus so majors compete with meme pumps on Jupiter trending lists. */
export const TIER1_SCORE_BONUS = 22
