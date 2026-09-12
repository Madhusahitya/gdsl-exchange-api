import type { AdapterBalance } from '../exchange/binanceSpotAdapter'
import { freeAsset } from '../exchange/binanceBalanceHelpers'

export type CexQuoteAsset = 'USDT' | 'USDC'

export type ResolvedCexSymbol = {
  symbol: string
  baseAsset: string
  quoteAsset: CexQuoteAsset
  pair: string
}

export function baseFromCexSymbol(raw: string): string {
  return raw.replace(/USDT$|USDC$/i, '').toUpperCase()
}

/** Pick BTCUSDT vs BTCUSDC based on what the user actually holds on Binance spot. */
export function resolveCexTradeSymbol(
  rawSymbol: string,
  balances: { freeUsdt: number; freeUsdc: number },
  side: 'BUY' | 'SELL',
  spendQuoteUsd?: number,
): ResolvedCexSymbol {
  const baseAsset = baseFromCexSymbol(rawSymbol)
  const need = spendQuoteUsd ?? 0

  if (side === 'BUY' && need > 0) {
    if (balances.freeUsdt >= need) {
      return { symbol: `${baseAsset}USDT`, baseAsset, quoteAsset: 'USDT', pair: `${baseAsset}/USDT` }
    }
    if (balances.freeUsdc >= need) {
      return { symbol: `${baseAsset}USDC`, baseAsset, quoteAsset: 'USDC', pair: `${baseAsset}/USDC` }
    }
  }

  if (balances.freeUsdc > balances.freeUsdt && balances.freeUsdc >= 5) {
    return { symbol: `${baseAsset}USDC`, baseAsset, quoteAsset: 'USDC', pair: `${baseAsset}/USDC` }
  }

  return { symbol: `${baseAsset}USDT`, baseAsset, quoteAsset: 'USDT', pair: `${baseAsset}/USDT` }
}

export function balancesFromAdapter(rows: AdapterBalance[]): { freeUsdt: number; freeUsdc: number } {
  return {
    freeUsdt: freeAsset(rows, 'USDT'),
    freeUsdc: freeAsset(rows, 'USDC'),
  }
}
