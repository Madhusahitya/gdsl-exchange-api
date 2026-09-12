/**
 * Multi-RPC failover with latency measurement.
 * Existing callers keep using getSolanaConnection() — behaviour stays compatible.
 */
import { Connection } from '@solana/web3.js'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'

/**
 * Public fallbacks. Do NOT include publicnode here — it often ranks as
 * "fastest" on getSlot probes, then blocks/timeouts on
 * getTokenAccountsByOwner(programId), which made Solana wallets show only
 * USDC+SOL while Solscan showed the full ~$76 portfolio.
 */
const PUBLIC_FALLBACKS = ['https://api.mainnet-beta.solana.com']

export type RpcEndpointStats = {
  url: string
  latencyMs: number | null
  ok: boolean
  lastError?: string
  lastCheckedAt: number
}

type PoolEntry = {
  url: string
  connection: Connection
  latencyMs: number
  failures: number
  lastOkAt: number
}

let pool: PoolEntry[] = []
let probeTimer: NodeJS.Timeout | null = null
const PROBE_INTERVAL_MS = 45_000

function configuredUrls(): string[] {
  const primary = env.SOLANA_RPC_URL?.trim()
  const extras = (process.env.SOLANA_RPC_URLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const urls = [...(primary ? [primary] : []), ...extras, ...PUBLIC_FALLBACKS]
  return [...new Set(urls)]
}

async function probeUrl(url: string): Promise<{ latencyMs: number; ok: boolean; error?: string }> {
  const started = Date.now()
  try {
    const conn = new Connection(url, { commitment: 'confirmed', confirmTransactionInitialTimeout: 20_000 })
    await Promise.race([
      conn.getSlot('processed'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('rpc timeout')), 4_000)),
    ])
    return { latencyMs: Date.now() - started, ok: true }
  } catch (err) {
    return {
      latencyMs: Date.now() - started,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function refreshPool(): Promise<void> {
  const urls = configuredUrls()
  const results = await Promise.all(
    urls.map(async (url) => {
      const probe = await probeUrl(url)
      return { url, ...probe }
    }),
  )
  const next: PoolEntry[] = []
  for (const r of results) {
    if (!r.ok) continue
    next.push({
      url: r.url,
      connection: new Connection(r.url, { commitment: 'confirmed', confirmTransactionInitialTimeout: 60_000 }),
      latencyMs: r.latencyMs,
      failures: 0,
      lastOkAt: Date.now(),
    })
  }
  next.sort((a, b) => a.latencyMs - b.latencyMs)
  if (next.length === 0) {
    // Never leave the process without a connection — keep public mainnet.
    const url = PUBLIC_FALLBACKS[0]
    next.push({
      url,
      connection: new Connection(url, 'confirmed'),
      latencyMs: 9_999,
      failures: 0,
      lastOkAt: 0,
    })
    logger.warn('[solana-rpc] all probes failed — using public mainnet fallback')
  } else if (pool[0]?.url !== next[0]?.url) {
    logger.info({ fastest: next[0].url, latencyMs: next[0].latencyMs }, '[solana-rpc] primary endpoint')
  }
  pool = next
}

function ensurePoolStarted(): void {
  if (pool.length === 0) {
    const url = env.SOLANA_RPC_URL?.trim() || PUBLIC_FALLBACKS[0]
    pool = [
      {
        url,
        connection: new Connection(url, 'confirmed'),
        latencyMs: 0,
        failures: 0,
        lastOkAt: Date.now(),
      },
    ]
    void refreshPool()
  }
  if (!probeTimer) {
    probeTimer = setInterval(() => void refreshPool(), PROBE_INTERVAL_MS)
    if (typeof probeTimer.unref === 'function') probeTimer.unref()
  }
}

/** Lowest-latency healthy RPC connection. */
export function getSolanaConnection(): Connection {
  ensurePoolStarted()
  return pool[0]!.connection
}

export function getSolanaRpcUrl(): string {
  ensurePoolStarted()
  return pool[0]!.url
}

export async function getSolanaRpcStats(): Promise<RpcEndpointStats[]> {
  const urls = configuredUrls()
  const probed = await Promise.all(
    urls.map(async (url) => {
      const p = await probeUrl(url)
      return {
        url,
        latencyMs: p.latencyMs,
        ok: p.ok,
        lastError: p.error,
        lastCheckedAt: Date.now(),
      } satisfies RpcEndpointStats
    }),
  )
  return probed.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1
    return (a.latencyMs ?? 9_999) - (b.latencyMs ?? 9_999)
  })
}

function isRateLimited(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('429') || /too many requests|rate limit/i.test(msg)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Backoff for a rate-limited endpoint before giving up on it.
 *
 * Failing over on a 429 only helps when there is somewhere to fail over to. In
 * the common deployment there is exactly one endpoint (the configured URL and
 * the public fallback are the same host), so a single 429 used to fail the whole
 * call — which is what made Solana token enumeration, and therefore wallet
 * balances, intermittently come back empty. The public endpoint serves these
 * methods fine; it just throttles bursts, so a short wait usually succeeds.
 */
const RATE_LIMIT_BACKOFF_MS = [400, 1_200]

/** Run an RPC call against the pool; on failure rotate to the next endpoint. */
export async function withSolanaRpc<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
  ensurePoolStarted()
  let lastErr: unknown
  // Prefer configured primary / mainnet before speculative "fast" free RPCs.
  const ordered = [...pool].sort((a, b) => {
    const primary = env.SOLANA_RPC_URL?.trim()
    if (primary && a.url === primary && b.url !== primary) return -1
    if (primary && b.url === primary && a.url !== primary) return 1
    if (a.url.includes('mainnet-beta') && !b.url.includes('mainnet-beta')) return -1
    if (b.url.includes('mainnet-beta') && !a.url.includes('mainnet-beta')) return 1
    return a.latencyMs - b.latencyMs
  })
  const isLastEndpoint = (entry: PoolEntry) => ordered[ordered.length - 1]?.url === entry.url
  for (const entry of ordered) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await Promise.race([
          fn(entry.connection),
          new Promise<never>((_, reject) => {
            // Token-account enumeration often needs >12s on public mainnet under load.
            setTimeout(() => reject(new Error(`rpc timeout (${entry.url})`)), 25_000)
          }),
        ])
        entry.failures = 0
        entry.lastOkAt = Date.now()
        return result
      } catch (err) {
        lastErr = err
        // Only wait when a retry can plausibly help: the endpoint throttled us
        // and either it is the last one left or we have not used up the budget.
        const backoff = RATE_LIMIT_BACKOFF_MS[attempt]
        if (isRateLimited(err) && backoff != null && (ordered.length === 1 || isLastEndpoint(entry))) {
          logger.warn(
            { url: entry.url, attempt: attempt + 1, backoffMs: backoff },
            '[solana-rpc] rate limited — retrying after backoff',
          )
          await sleep(backoff)
          continue
        }
        entry.failures += 1
        logger.warn(
          { url: entry.url, err: err instanceof Error ? err.message : String(err) },
          '[solana-rpc] endpoint failed — failing over',
        )
        // Push failing endpoint to the end
        pool = [...pool.filter((p) => p.url !== entry.url), entry]
        break
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
