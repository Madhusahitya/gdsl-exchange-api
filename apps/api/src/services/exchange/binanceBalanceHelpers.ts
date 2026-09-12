import type { AdapterBalance } from './binanceSpotAdapter'

/** Spot quote stables used for sizing CEX buys (USDT pairs). */
export const BINANCE_QUOTE_STABLES = ['USDT', 'USDC', 'BUSD', 'FDUSD'] as const

export function freeAsset(balances: AdapterBalance[], asset: string): number {
  return balances.find((b) => b.asset === asset)?.free ?? 0
}

export function sumQuoteStables(balances: AdapterBalance[]): number {
  return BINANCE_QUOTE_STABLES.reduce((sum, asset) => sum + freeAsset(balances, asset), 0)
}

export function topNonZeroBalances(balances: AdapterBalance[], limit = 12): AdapterBalance[] {
  return balances
    .filter((b) => b.free > 0.000_000_1 || b.locked > 0.000_000_1)
    .sort((a, b) => b.free + b.locked - (a.free + a.locked))
    .slice(0, limit)
}
