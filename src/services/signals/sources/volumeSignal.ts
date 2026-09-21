import { featureEngine } from '../../market/featureEngine'

export async function volumeSignal(symbol: string, interval: string): Promise<'UP' | 'DOWN' | 'NEUTRAL'> {
  const f = await featureEngine.getLatest(symbol, interval)
  if (!f || isNaN(f.volRatio) || isNaN(f.slope5)) return 'NEUTRAL'
  if (f.volRatio < 1.5) return 'NEUTRAL'  // no spike
  if (f.slope5 > 0) return 'UP'   // high volume + upward momentum
  if (f.slope5 < 0) return 'DOWN'
  return 'NEUTRAL'
}
