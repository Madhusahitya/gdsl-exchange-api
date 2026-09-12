import { loadExecutorConfig } from './config'
import { createBinanceExecutor } from './binanceExecutor'
import { logTrade } from './logger'
import { usdNotionalToBaseQuantity } from './sizing'
import { evaluateMarketBuySafety } from './safety'
import { assertMinNotionalMet, assertValidQuantityForSymbol } from './validation'

const DEMO_SYMBOL = 'BTCUSDT'
const DEMO_USD = 2

/**
 * Demo: fetch USDT, size $2 BTCUSDT BUY, validate, simulate or live market order.
 */
export async function runDemoTrade(): Promise<void> {
  let cfg
  try {
    cfg = loadExecutorConfig()
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    logTrade('trade.rejected', {
      symbol: DEMO_SYMBOL,
      side: 'BUY',
      quantity: null,
      price: null,
      reason: `CONFIG: ${reason}`,
    })
    return
  }

  const ex = createBinanceExecutor(cfg)

  logTrade('trade.attempt', {
    symbol: DEMO_SYMBOL,
    side: 'BUY',
    quantity: null,
    price: null,
    usdNotional: DEMO_USD,
    demoMode: cfg.demoMode,
  })

  let rules
  let price
  let balances
  try {
    ;[rules, price, balances] = await Promise.all([
      ex.getSymbolInfo(DEMO_SYMBOL),
      ex.getLastPrice(DEMO_SYMBOL),
      ex.getAccountBalance(),
    ])
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    logTrade('trade.rejected', {
      symbol: DEMO_SYMBOL,
      side: 'BUY',
      quantity: null,
      price: null,
      reason: `MARKET_DATA: ${reason}`,
    })
    return
  }

  const usdtFree = balances['USDT'] ?? 0

  let quantityStr: string
  try {
    quantityStr = usdNotionalToBaseQuantity(DEMO_USD, price, rules)
    assertValidQuantityForSymbol(quantityStr, rules)
    assertMinNotionalMet(quantityStr, price, rules)
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    logTrade('trade.rejected', {
      symbol: DEMO_SYMBOL,
      side: 'BUY',
      quantity: null,
      price,
      reason: `SIZING: ${reason}`,
    })
    return
  }

  const safety = evaluateMarketBuySafety({
    cfg,
    rules,
    quantityStr,
    refPrice: price,
    usdtFree,
  })

  if (!safety.ok) {
    logTrade('trade.rejected', {
      symbol: DEMO_SYMBOL,
      side: 'BUY',
      quantity: quantityStr,
      price,
      reason: safety.reason,
    })
    return
  }

  logTrade('trade.validated', {
    symbol: DEMO_SYMBOL,
    side: 'BUY',
    quantity: quantityStr,
    price,
    notionalUsd: safety.notionalUsd,
    feeUsd: safety.feeUsd,
    requiredQuote: safety.requiredQuote,
  })

  if (cfg.demoMode) {
    const simulatedId = `DEMO-${Date.now()}`
    logTrade('trade.executed', {
      symbol: DEMO_SYMBOL,
      side: 'BUY',
      quantity: quantityStr,
      price,
      orderId: simulatedId,
      status: 'SIMULATED',
      reason: null,
      note: 'DEMO_MODE=true; order not sent to Binance',
    })
    return
  }

  try {
    const order = await ex.placeMarketOrder(DEMO_SYMBOL, 'BUY', quantityStr)
    logTrade('trade.executed', {
      symbol: DEMO_SYMBOL,
      side: 'BUY',
      quantity: quantityStr,
      price,
      orderId: order.orderId,
      status: String(order.status ?? 'UNKNOWN'),
      reason: null,
    })
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    logTrade('trade.rejected', {
      symbol: DEMO_SYMBOL,
      side: 'BUY',
      quantity: quantityStr,
      price,
      reason: `EXECUTION: ${reason}`,
    })
  }
}
