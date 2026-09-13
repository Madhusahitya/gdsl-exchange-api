/**
 * Bridge `executeUnifiedTrade(..., { binanceExecutor })` to Binance spot MARKET orders.
 * Uses @cryptoflow/binance-executor for REST, sizing, and safety patterns.
 */
import type { BinanceUnifiedExecutor, UnifiedTradeRequest, UnifiedTradeResult } from '@cryptoflow/bot'
import {
  loadExecutorConfig,
  createBinanceExecutor,
  usdNotionalToBaseQuantity,
  evaluateMarketBuySafety,
} from '@cryptoflow/binance-executor'

function marketBuySymbol(quoteIn: string, baseOut: string): string {
  const q = quoteIn.trim().toUpperCase()
  const b = baseOut.trim().toUpperCase()
  if (q !== 'USDT') {
    throw new Error('Binance unified MARKET BUY expects quote tokenIn USDT')
  }
  if (b === 'BTC') return 'BTCUSDT'
  if (b === 'ETH') return 'ETHUSDT'
  if (b === 'SOL') return 'SOLUSDT'
  throw new Error(`Unsupported base asset for USDT pair: ${baseOut}`)
}

export function createBinanceUnifiedExecutorFromEnv(): BinanceUnifiedExecutor {
  return async (req: UnifiedTradeRequest): Promise<UnifiedTradeResult> => {
    if (req.platform !== 'binance') {
      throw new Error('createBinanceUnifiedExecutorFromEnv only handles platform binance')
    }
    const cfg = loadExecutorConfig()
    const ex = createBinanceExecutor(cfg)
    const symbol = marketBuySymbol(req.tokenIn, req.tokenOut)
    const quoteAsset = 'USDT'
    const rules = await ex.getSymbolInfo(symbol)
    const price = await ex.getLastPrice(symbol)
    const balances = await ex.getAccountBalance()

    const usd = req.amount
    const qtyStr = usdNotionalToBaseQuantity(usd, price, rules)
    const usdtFree = balances[quoteAsset] ?? 0
    const safety = evaluateMarketBuySafety({
      cfg,
      rules,
      quantityStr: qtyStr,
      refPrice: price,
      usdtFree,
    })
    if (!safety.ok) {
      throw new Error(safety.reason)
    }
    if (cfg.demoMode) {
      return {
        platform: 'binance',
        chain: 'CEX',
        txHash: `DEMO-BINANCE-${Date.now()}`,
        status: 1,
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountIn: req.amount,
        details: { quantity: qtyStr, simulated: true },
      }
    }
    const order = await ex.placeMarketOrder(symbol, 'BUY', qtyStr)
    return {
      platform: 'binance',
      chain: 'CEX',
      txHash: String(order.orderId),
      status: 1,
      tokenIn: req.tokenIn,
      tokenOut: req.tokenOut,
      amountIn: req.amount,
      details: { quantity: qtyStr, order },
    }
  }
}
