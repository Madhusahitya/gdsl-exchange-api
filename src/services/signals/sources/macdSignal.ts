import { featureEngine } from '../../market/featureEngine'

export async function macdSignal(symbol: string, interval: string): Promise<'UP' | 'DOWN' | 'NEUTRAL'> {
  const f = await featureEngine.getLatest(symbol, interval)
  if (!f || isNaN(f.macdHist) || isNaN(f.macdHistPrev)) return 'NEUTRAL'
  const expanding = Math.abs(f.macdHist) > Math.abs(f.macdHistPrev)
  if (f.macdHist > 0 && expanding) return 'UP'
  if (f.macdHist < 0 && expanding) return 'DOWN'
  return 'NEUTRAL'
}
