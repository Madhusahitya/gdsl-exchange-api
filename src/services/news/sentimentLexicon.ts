/**
 * Lightweight crypto-domain sentiment scorer.
 * Score ∈ [-1, 1]. Positive = bullish, negative = bearish.
 */

const POSITIVE_WORDS = new Set([
  'surge','surged','surging','rally','rallied','rallying','bullish','bull','uptrend',
  'adopt','adoption','adopted','partnership','partnerships','launch','launched','launched',
  'upgrade','upgraded','approve','approved','approval','breakthrough','milestone',
  'record','high','ath','all-time','gain','gains','gained','rise','rises','rose','risen',
  'pump','pumped','recovery','recover','recovered','buy','buying','accumulate','accumulating',
  'invest','investment','institutional','etf','integration','listing','listed','mainstream',
  'positive','optimistic','confidence','confident','growth','growing','expand','expansion',
  'support','supported','inflow','inflows','custody','regulated','regulation-friendly',
])

const NEGATIVE_WORDS = new Set([
  'crash','crashed','crashing','plunge','plunged','plunging','bearish','bear','downtrend',
  'hack','hacked','hacking','exploit','exploited','breach','breached','stolen','theft',
  'reject','rejected','rejection','lawsuit','sued','suing','ban','banned','banning',
  'delist','delisted','delisting','bankrupt','bankruptcy','insolvent','insolvency',
  'fraud','fraudulent','scam','ponzi','rug','rugpull','liquidation','liquidated',
  'sell','selling','selloff','dump','dumped','dumping','outflow','outflows',
  'negative','pessimistic','concern','concerns','fear','collapse','collapsed','collapses',
  'regulation','restrict','restricted','seizure','seized','penalty','fine','fined',
  'vulnerability','bug','attack','attacked','malware','phishing','lose','loss','losses',
])

/** Tokenize text into lowercase words */
function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/\s+/).filter(Boolean)
}

/**
 * Score a piece of text.
 * Returns a value in [-1, 1].
 */
export function scoreSentiment(text: string): number {
  const tokens = tokenize(text)
  let pos = 0
  let neg = 0

  for (const t of tokens) {
    if (POSITIVE_WORDS.has(t)) pos++
    if (NEGATIVE_WORDS.has(t)) neg++
  }

  const total = pos + neg
  if (total === 0) return 0
  return (pos - neg) / total
}
