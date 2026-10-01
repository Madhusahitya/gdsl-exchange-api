import test from 'node:test'
import assert from 'node:assert/strict'
import { compareTradeRank } from './candidateRank'

test('a clearly better token ranks ahead of a major', () => {
  const major = { totalScore: 0.7, isMajor: true }
  const alt = { totalScore: 0.82, isMajor: false }
  const ranked = [major, alt].sort(compareTradeRank)
  assert.equal(ranked[0], alt)
})

test('a major wins only when the scores are a near tie', () => {
  const major = { totalScore: 0.8, isMajor: true }
  const alt = { totalScore: 0.81, isMajor: false }
  const ranked = [alt, major].sort(compareTradeRank)
  assert.equal(ranked[0], major)
})
