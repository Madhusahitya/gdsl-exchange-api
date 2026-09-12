import { prisma } from '@cryptoflow/db'

const SYMBOL_KEYWORDS: Record<string, string[]> = {
  BTCUSDT: ['BTC', 'bitcoin', 'Bitcoin'],
  ETHUSDT: ['ETH', 'ethereum', 'Ethereum'],
  SOLUSDT: ['SOL', 'solana', 'Solana'],
  BNBUSDT: ['BNB', 'binance coin', 'Binance Coin', 'BinanceCoin'],
  XRPUSDT: ['XRP', 'ripple', 'Ripple'],
  DOGEUSDT: ['DOGE', 'dogecoin', 'Dogecoin'],
  USDCUSDT: ['USDC', 'usd coin', 'USD Coin'],
}

export async function newsSentimentSignal(symbol: string): Promise<'UP' | 'DOWN' | 'NEUTRAL'> {
  const keywords = SYMBOL_KEYWORDS[symbol] ?? []
  if (keywords.length === 0) return 'NEUTRAL'

  const since = new Date(Date.now() - 6 * 60 * 60 * 1000)  // last 6h
  const events = await prisma.newsEvent.findMany({
    where: {
      publishedAt: { gte: since },
      symbolsMentioned: { hasSome: keywords },
    },
    select: { sentimentScore: true },
  })

  if (events.length === 0) return 'NEUTRAL'

  const avg = events.reduce((sum, e) => sum + Number(e.sentimentScore), 0) / events.length

  if (avg > 0.3) return 'UP'
  if (avg < -0.3) return 'DOWN'
  return 'NEUTRAL'
}
