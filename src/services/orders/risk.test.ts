import test from 'node:test'
import assert from 'node:assert/strict'

function exceedsOrderNotional(maxOrderNotional: number, quantity: number, price: number): boolean {
  return quantity * price > maxOrderNotional
}

test('detects notional above limit', () => {
  assert.equal(exceedsOrderNotional(100, 2, 60), true)
})

test('allows notional under limit', () => {
  assert.equal(exceedsOrderNotional(1000, 1, 100), false)
})
