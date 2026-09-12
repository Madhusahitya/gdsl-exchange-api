import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeLiveOrderSize, floorUsdt } from './liveOrderSizing'

describe('computeLiveOrderSize', () => {
  it('uses tradeSizePct of free USDT instead of 90% default', () => {
    const r = computeLiveOrderSize({ freeUsdt: 100, tradeSizePct: 20 })
    assert.equal(r.orderSizeUsdt, 20)
  })

  it('applies env max cap', () => {
    const r = computeLiveOrderSize({
      freeUsdt: 500,
      tradeSizePct: 50,
      envMaxOrderUsdt: 25,
    })
    assert.equal(r.orderSizeUsdt, 25)
    assert.ok(r.reasons.some((x) => x.includes('CEX env max')))
  })

  it('applies risk maxOrderNotional', () => {
    const r = computeLiveOrderSize({
      freeUsdt: 200,
      tradeSizePct: 100,
      maxOrderNotional: 40,
      envMaxOrderUsdt: 100,
    })
    assert.equal(r.orderSizeUsdt, 40)
  })

  it('honors requested order size when smaller', () => {
    const r = computeLiveOrderSize({
      freeUsdt: 200,
      tradeSizePct: 50,
      requestedOrderSizeUsdt: 15,
      envMaxOrderUsdt: 100,
    })
    assert.equal(r.orderSizeUsdt, 15)
  })

  it('floors to cents', () => {
    assert.equal(floorUsdt(12.999), 12.99)
  })

  it('reports below minimum when balance too small', () => {
    const r = computeLiveOrderSize({ freeUsdt: 8, tradeSizePct: 20, minOrderUsdt: 5 })
    assert.ok(r.orderSizeUsdt < 5)
    assert.ok(r.reasons.some((x) => x.includes('Below minimum')))
  })
})
