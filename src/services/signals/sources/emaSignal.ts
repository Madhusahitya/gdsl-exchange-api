import { featureEngine } from '../../market/featureEngine'

export async function emaSignal(symbol: string, interval: string): Promise<'UP' | 'DOWN' | 'NEUTRAL'> {
  const f = await featureEngine.getLatest(symbol, interval)
  if (!f || isNaN(f.ema20) || isNaN(f.ema50)) return 'NEUTRAL'
  const ratio = f.ema20 / f.ema50
  if (ratio > 1.003) return 'UP'
  if (ratio < 0.997) return 'DOWN'
  return 'NEUTRAL'
}
