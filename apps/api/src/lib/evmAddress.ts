import { getAddress, isAddress } from 'ethers'

/**
 * Normalize a user-pasted EVM address: trim whitespace, accept 40 hex chars
 * without 0x prefix (common on exchange UIs), return EIP-55 checksummed form.
 */
export function parseEvmWithdrawAddress(input: string): string {
  const trimmed = input.trim().replace(/\s+/g, '')
  let candidate = trimmed
  if (/^[a-fA-F0-9]{40}$/i.test(trimmed) && !trimmed.toLowerCase().startsWith('0x')) {
    candidate = `0x${trimmed}`
  }
  if (!isAddress(candidate)) {
    throw new Error('Invalid destination address')
  }
  return getAddress(candidate)
}
