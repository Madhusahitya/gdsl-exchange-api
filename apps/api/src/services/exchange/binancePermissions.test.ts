import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getBinancePermissionState,
  inferBinanceApiKeyCanWithdraw,
  sanitizeBinanceCredential,
} from './binancePermissions'

describe('getBinancePermissionState', () => {
  it('does not treat account-level canWithdraw as API-key withdraw', () => {
    const state = getBinancePermissionState({
      canTrade: true,
      canWithdraw: true, // account can withdraw via website
      canDeposit: true,
      permissions: ['SPOT'],
    })
    assert.equal(state.canTrade, true)
    assert.equal(state.canWithdraw, false)
    assert.equal(state.accountCanWithdraw, true)
  })

  it('flags withdraw when permissions include WITHDRAW', () => {
    assert.equal(
      inferBinanceApiKeyCanWithdraw({ permissions: ['SPOT', 'WITHDRAW'] }),
      true,
    )
    const state = getBinancePermissionState({
      canWithdraw: false,
      permissions: ['SPOT', 'WITHDRAWALS'],
    })
    assert.equal(state.canWithdraw, true)
  })

  it('allows trade-only SPOT keys', () => {
    const state = getBinancePermissionState({
      canWithdraw: true,
      permissions: ['SPOT'],
    })
    assert.equal(state.canTrade, true)
    assert.equal(state.canWithdraw, false)
  })
})

describe('sanitizeBinanceCredential', () => {
  it('strips trailing colons and whitespace', () => {
    assert.equal(sanitizeBinanceCredential('  abc:def:::  '), 'abc:def')
    assert.equal(sanitizeBinanceCredential('"quoted"'), 'quoted')
  })
})
