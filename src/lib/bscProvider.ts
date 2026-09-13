/**
 * Shared BSC JSON-RPC provider with **multi-endpoint fallback**.
 *
 * Why: a personal-wallet swap fires 8–15 JSON-RPC calls in rapid succession
 * (`eth_chainId`, `eth_call` allowance / getAmountsOut, `eth_estimateGas`,
 * `eth_gasPrice`, `eth_getTransactionCount`, `eth_sendRawTransaction`, plus
 * receipt polling). On a free-tier QuickNode (15 req/sec) one or two
 * concurrent users instantly trip the rate limit and the swap aborts with
 *   `-32007  15/second request limit reached`
 * causing the "Trade failed" Telegram alert investors saw.
 *
 * Fix: build an ethers v6 `FallbackProvider` across every configured URL so
 * any single provider stalling or 429-ing simply moves the next request to
 * the next provider. We always include reputable free public BSC RPCs as
 * final fallbacks so the system survives even if all paid endpoints are
 * down.
 *
 * Order of priority:
 *   1. `BSC_RPC_URL` (your primary, e.g. paid QuickNode)
 *   2. `BSC_RPC_URL_FALLBACK_1..3` (optional extra paid/reserve endpoints)
 *   3. Hard-coded public RPCs (always tried last)
 *
 * The provider is **cached** at module scope — recreating ethers providers
 * on every call leaks sockets and starts a fresh chainId discovery round
 * trip each time.
 */

import { FallbackProvider, JsonRpcProvider, Network } from 'ethers'
import { env } from './env'
import { logger } from './logger'

const BSC_CHAIN_ID = 56

/** Stable, free public BSC RPCs used as last-resort fallbacks. */
const PUBLIC_BSC_RPCS: readonly string[] = [
  'https://bsc.publicnode.com',
  'https://1rpc.io/bnb',
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.defibit.io',
] as const

function uniqueUrls(urls: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of urls) {
    const u = raw?.trim()
    if (!u) continue
    if (seen.has(u)) continue
    seen.add(u)
    out.push(u)
  }
  return out
}

function buildProviderList(): JsonRpcProvider[] {
  const urls = uniqueUrls([
    env.BSC_RPC_URL,
    env.BSC_RPC_URL_FALLBACK_1,
    env.BSC_RPC_URL_FALLBACK_2,
    env.BSC_RPC_URL_FALLBACK_3,
    ...PUBLIC_BSC_RPCS,
  ])

  // Pin the network on each provider so ethers does not race a `chainId`
  // round trip on first use (which itself could 429 on a hot QuickNode).
  const network = new Network('bnb', BSC_CHAIN_ID)
  return urls.map(
    (url) =>
      new JsonRpcProvider(url, network, {
        staticNetwork: network,
        batchMaxCount: 1, // public RPCs frequently reject batched JSON-RPC
      }),
  )
}

type AnyBscProvider = FallbackProvider | JsonRpcProvider
let cachedProvider: AnyBscProvider | null = null

/**
 * Return a shared BSC provider. Single-URL case returns a plain
 * `JsonRpcProvider` (so `wallet.connect(provider)` still works trivially);
 * multi-URL case returns a `FallbackProvider` with `quorum: 1` so the first
 * provider to answer wins.
 */
export function getBscProvider(): AnyBscProvider {
  if (cachedProvider) return cachedProvider

  const providers = buildProviderList()
  if (providers.length === 0) {
    // Should never happen — PUBLIC_BSC_RPCS is non-empty — but be defensive.
    cachedProvider = new JsonRpcProvider('https://bsc.publicnode.com', {
      chainId: BSC_CHAIN_ID,
      name: 'bnb',
    })
    return cachedProvider
  }

  if (providers.length === 1) {
    cachedProvider = providers[0]
    return cachedProvider
  }

  const fallbackConfigs = providers.map((provider, index) => ({
    provider,
    priority: index + 1,
    weight: 1,
    // Stall fast on the primary so a rate-limited QuickNode is bypassed in
    // ~1.5s rather than after a full timeout.
    stallTimeout: 1500,
  }))

  cachedProvider = new FallbackProvider(fallbackConfigs, new Network('bnb', BSC_CHAIN_ID), {
    quorum: 1,
  })

  logger.info(
    { providerCount: providers.length },
    '[bscProvider] FallbackProvider initialized for BSC',
  )
  return cachedProvider
}

/**
 * For modules that explicitly need a plain `JsonRpcProvider` (e.g. wallet
 * signing in some ethers v6 code paths that prefer a single provider).
 * Returns the **primary** RPC only — caller must handle failures.
 */
export function getBscPrimaryJsonRpcProvider(): JsonRpcProvider {
  const network = new Network('bnb', BSC_CHAIN_ID)
  return new JsonRpcProvider(env.BSC_RPC_URL, network, {
    staticNetwork: network,
    batchMaxCount: 1,
  })
}

/** Reset the cached provider — used by tests, never in production code. */
export function __resetBscProviderForTests(): void {
  cachedProvider = null
}
