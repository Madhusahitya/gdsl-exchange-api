import { Contract, FallbackProvider, formatEther, formatUnits, JsonRpcProvider, Wallet } from 'ethers'
import { BSC_CHAIN_ID, USDT_BSC, erc20Abi } from '@cryptoflow/dex-pancake'
import { getBscProvider } from '../../lib/bscProvider'

function readRawKey(): string | undefined {
  const k = process.env.HOT_WALLET_PRIVATE_KEY?.trim()
  return k && k.length > 0 ? k : undefined
}

export function isHotWalletConfigured(): boolean {
  return Boolean(readRawKey())
}

function normalizePrivateKey(raw: string): string {
  const hex = raw.startsWith('0x') ? raw : `0x${raw}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('HOT_WALLET_PRIVATE_KEY must be 64 hex chars (optional 0x prefix)')
  }
  return hex
}

/**
 * Shared multi-endpoint BSC provider. Falls back across QuickNode + public
 * RPCs so a single endpoint rate-limiting (`-32007 15/second limit reached`)
 * does not abort a trade. See lib/bscProvider.ts for details.
 */
export function getBscJsonRpcProvider(): FallbackProvider | JsonRpcProvider {
  return getBscProvider()
}

/** Returns null if env key is unset; throws if set but malformed. */
export function getHotWalletSigner(): Wallet | null {
  const raw = readRawKey()
  if (!raw) return null
  return new Wallet(normalizePrivateKey(raw), getBscJsonRpcProvider())
}

export type HotWalletOnChainSummary = {
  chainId: typeof BSC_CHAIN_ID
  address: `0x${string}`
  bnbFormatted: string
  usdtFormatted: string
}

export async function getHotWalletOnChainSummary(): Promise<HotWalletOnChainSummary | null> {
  const wallet = getHotWalletSigner()
  if (!wallet) return null
  const provider = getBscJsonRpcProvider()
  const usdt = new Contract(USDT_BSC, erc20Abi, provider)
  const [bnbWei, usdtRaw] = await Promise.all([
    provider.getBalance(wallet.address),
    usdt.balanceOf(wallet.address),
  ])
  return {
    chainId: BSC_CHAIN_ID,
    address: wallet.address as `0x${string}`,
    bnbFormatted: formatEther(bnbWei),
    usdtFormatted: formatUnits(usdtRaw, 18),
  }
}
