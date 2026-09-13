/**
 * Platform fee treasury — every fee the platform deducts (cross-chain transfer
 * settlement fee, convert platform fee) is delivered to these operator-owned
 * wallets rather than accumulating in the hot bridge wallets.
 *
 * BSC fees (BEP-20 / native BNB) go to the EVM treasury address.
 * Solana fees (SPL / native SOL) go to the Solana treasury address.
 * Override via FEE_TREASURY_BSC / FEE_TREASURY_SOL env vars.
 */

const DEFAULT_TREASURY_BSC = '0x7325930d29265B520346514447f4917a77e2127c'
const DEFAULT_TREASURY_SOL = 'BqyVRbHMheue92aSVtr1uVMotAk2MuXZb5y8M1V8KhVV'

export function feeTreasuryBsc(): string {
  const v = process.env.FEE_TREASURY_BSC?.trim()
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : DEFAULT_TREASURY_BSC
}

export function feeTreasurySol(): string {
  const v = process.env.FEE_TREASURY_SOL?.trim()
  return v && v.length >= 32 ? v : DEFAULT_TREASURY_SOL
}

/** Flat platform fee (USD) charged on same-chain converts. */
export const CONVERT_FEE_USD = 0.1
