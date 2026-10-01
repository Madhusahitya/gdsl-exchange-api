/** Higher composite score wins. A major only wins when the scores are a near tie. */
export function compareTradeRank(
  a: { totalScore: number; isMajor: boolean },
  b: { totalScore: number; isMajor: boolean },
  tieBand = 0.04,
): number {
  if (Math.abs(a.totalScore - b.totalScore) >= tieBand) return b.totalScore - a.totalScore
  if (a.isMajor !== b.isMajor) return a.isMajor ? -1 : 1
  return b.totalScore - a.totalScore
}
