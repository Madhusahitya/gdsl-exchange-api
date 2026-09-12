import test from 'node:test'
import assert from 'node:assert/strict'
import {
  adjustQuantityToLotSize,
  notionalForQuantity,
  parseSymbolRules,
} from '@cryptoflow/binance-executor'

/** Shape of a real BTCUSDT exchangeInfo entry, trimmed to the filters we read. */
const btcUsdt = parseSymbolRules({
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  filters: [
    { filterType: 'LOT_SIZE', minQty: '0.00001000', maxQty: '9000.00000000', stepSize: '0.00001000' },
    { filterType: 'NOTIONAL', minNotional: '5.00000000' },
  ],
} as Parameters<typeof parseSymbolRules>[0])

test('floors quantity to stepSize instead of sending full precision', () => {
  // What the CEX Super Machine used to send straight to Binance (-1111 PRECISION).
  assert.equal(adjustQuantityToLotSize(0.000123456789, btcUsdt), '0.00012')
})

test('keeps an already-aligned quantity unchanged', () => {
  assert.equal(adjustQuantityToLotSize(0.00012, btcUsdt), '0.00012')
})

test('reads minNotional from the NOTIONAL filter', () => {
  assert.equal(btcUsdt.minNotional, 5)
})

test('detects an order that would be rejected for minNotional', () => {
  const qty = adjustQuantityToLotSize(0.00001, btcUsdt)
  const notional = notionalForQuantity(qty, 79_000)
  assert.ok(notional < btcUsdt.minNotional, `expected ${notional} to be under ${btcUsdt.minNotional}`)
})

test('accepts an order that clears minNotional', () => {
  const qty = adjustQuantityToLotSize(0.0001, btcUsdt)
  const notional = notionalForQuantity(qty, 79_000)
  assert.ok(notional >= btcUsdt.minNotional, `expected ${notional} to clear ${btcUsdt.minNotional}`)
})

test('prefers MARKET_LOT_SIZE over LOT_SIZE when both are present', () => {
  const rules = parseSymbolRules({
    symbol: 'ETHUSDT',
    baseAsset: 'ETH',
    quoteAsset: 'USDT',
    filters: [
      { filterType: 'LOT_SIZE', minQty: '0.00010000', maxQty: '9000.00000000', stepSize: '0.00010000' },
      { filterType: 'MARKET_LOT_SIZE', minQty: '0.00100000', maxQty: '5000.00000000', stepSize: '0.00100000' },
      { filterType: 'NOTIONAL', minNotional: '5.00000000' },
    ],
  } as Parameters<typeof parseSymbolRules>[0])
  assert.equal(rules.lot.stepSize, '0.00100000')
  assert.equal(adjustQuantityToLotSize(0.0129, rules), '0.012')
})
