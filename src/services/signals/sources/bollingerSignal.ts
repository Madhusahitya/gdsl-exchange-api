import { featureEngine } from '../../market/featureEngine'

export async function bollingerSignal(symbol: string, interval: string): Promise<'UP' | 'DOWN' | 'NEUTRAL'> {
  const f = await featureEngine.getLatest(symbol, interval)
  if (!f || isNaN(f.bbPos)) return 'NEUTRAL'
  // bbPos: 0 = at lower band, 1 = at upper band
  if (f.bbPos < 0.1) return 'UP'   // price at/below lower band → mean reversion up
  if (f.bbPos > 0.9) return 'DOWN' // price at/above upper band → mean reversion down
  return 'NEUTRAL'
}
