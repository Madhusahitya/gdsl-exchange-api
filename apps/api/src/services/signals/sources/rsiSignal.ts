import { featureEngine } from '../../market/featureEngine'

export async function rsiSignal(symbol: string, interval: string): Promise<'UP' | 'DOWN' | 'NEUTRAL'> {
  const f = await featureEngine.getLatest(symbol, interval)
  if (!f || isNaN(f.rsi14)) return 'NEUTRAL'
  const r = f.rsi14
  // Oversold bounce potential
  if (r < 35) return 'UP'
  // Overbought pullback potential
  if (r > 65) return 'DOWN'
  return 'NEUTRAL'
}
