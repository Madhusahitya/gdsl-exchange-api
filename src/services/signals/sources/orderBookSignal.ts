import { orderBookService } from '../../market/orderBook'

export async function orderBookSignal(symbol: string): Promise<'UP' | 'DOWN' | 'NEUTRAL'> {
  const obi = orderBookService.getOBI(symbol)
  if (obi === null) return 'NEUTRAL'
  if (obi > 0.2) return 'UP'
  if (obi < -0.2) return 'DOWN'
  return 'NEUTRAL'
}
