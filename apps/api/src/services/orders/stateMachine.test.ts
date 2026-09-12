import test from 'node:test'
import assert from 'node:assert/strict'
import { canTransitionOrderStatus } from './stateMachine'

test('allows pending submit to new', () => {
  assert.equal(canTransitionOrderStatus('PENDING_SUBMIT', 'NEW'), true)
})

test('rejects filled to partially_filled', () => {
  assert.equal(canTransitionOrderStatus('FILLED', 'PARTIALLY_FILLED'), false)
})
