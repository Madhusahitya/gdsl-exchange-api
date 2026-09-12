/**
 * Jupiter Swap API v2 (Meta-Aggregator) — successor to Ultra; same /order + /execute flow.
 * https://developers.jup.ag/docs/swap/order-and-execute
 */
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'

const DEFAULT_BASE = 'https://api.jup.ag/swap/v2'

export type JupiterOrderResponse = {
  inputMint: string
  outputMint: string
  inAmount: string
  outAmount: string
  otherAmountThreshold?: string
  swapMode?: string
  slippageBps?: number
  priceImpactPct?: string
  routePlan?: unknown[]
  transaction: string | null
  requestId: string
  router?: string
  mode?: string
  prioritizationFeeLamports?: number
  latencyMs?: number
}

export type JupiterExecuteResponse = {
  status: string
  signature?: string
  error?: string
  code?: string
}

function apiBase(): string {
  const custom = env.JUPITER_API_BASE?.trim()
  return custom ? custom.replace(/\/$/, '') : DEFAULT_BASE
}

export function isJupiterConfigured(): boolean {
  return Boolean(env.JUPITER_API_KEY?.trim())
}

async function jupiterHeaders(): Promise<Record<string, string>> {
  const key = env.JUPITER_API_KEY?.trim()
  if (!key) throw new Error('JUPITER_API_KEY is not configured on the server.')
  return {
    'x-api-key': key,
    Accept: 'application/json',
  }
}

/** Short cache for price-only (taker-less) quote orders — keep short for live trading. */
const quoteOrderCache = new Map<string, { at: number; body: JupiterOrderResponse }>()
const QUOTE_ORDER_TTL_MS = 2_500
/** When Jupiter returns 429, serve stale quotes up to this age. */
const QUOTE_ORDER_STALE_MS = 45_000

let swapRateLimitedUntil = 0
let lastOrderFetchAt = 0
/** Minimum gap between outbound /order calls — Developer tier tolerates ~10 RPS. */
const MIN_ORDER_GAP_MS = 120
/** Back-off after 429 — long enough for the sliding window to recover under Free/Developer. */
const RATE_LIMIT_BACKOFF_MS = 12_000

export function isJupiterSwapRateLimited(): boolean {
  return Date.now() < swapRateLimitedUntil
}

async function throttleSwapOrderFetch(): Promise<void> {
  const now = Date.now()
  const wait = MIN_ORDER_GAP_MS - (now - lastOrderFetchAt)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastOrderFetchAt = Date.now()
}

function staleCachedOrder(cacheKey: string): JupiterOrderResponse | null {
  const hit = quoteOrderCache.get(cacheKey)
  if (!hit) return null
  if (Date.now() - hit.at <= QUOTE_ORDER_STALE_MS) return { ...hit.body, latencyMs: 0 }
  return null
}

/** Same mint pair, different size — scale outAmount so a busy window still shows a usable quote. */
function staleCachedOrderByMints(inputMint: string, outputMint: string, amountRaw: string): JupiterOrderResponse | null {
  let amountNum: bigint
  try {
    amountNum = BigInt(amountRaw)
  } catch {
    return null
  }
  if (amountNum <= 0n) return null

  let best: { at: number; body: JupiterOrderResponse; cachedAmt: bigint } | null = null
  for (const [key, hit] of quoteOrderCache) {
    if (Date.now() - hit.at > QUOTE_ORDER_STALE_MS) continue
    const parts = key.split('|')
    if (parts.length < 3) continue
    const [inM, outM, amt] = parts
    if (inM !== inputMint || outM !== outputMint) continue
    let cachedAmt: bigint
    try {
      cachedAmt = BigInt(amt)
    } catch {
      continue
    }
    if (cachedAmt <= 0n) continue
    if (!best || hit.at > best.at) best = { at: hit.at, body: hit.body, cachedAmt }
  }
  if (!best) return null

  let outNum: bigint
  try {
    outNum = BigInt(best.body.outAmount)
  } catch {
    return null
  }
  const scaledOut = (outNum * amountNum) / best.cachedAmt
  if (scaledOut <= 0n) return null
  return {
    ...best.body,
    inAmount: amountRaw,
    outAmount: String(scaledOut),
    latencyMs: 0,
  }
}

function resolveStaleQuote(cacheKey: string, inputMint: string, outputMint: string, amountRaw: string): JupiterOrderResponse | null {
  return (
    staleCachedOrder(cacheKey) ??
    staleCachedOrderByMints(inputMint, outputMint, amountRaw)
  )
}

async function waitForRateLimitWindow(): Promise<void> {
  const waitMs = swapRateLimitedUntil - Date.now()
  if (waitMs <= 0) return
  await new Promise((r) => setTimeout(r, Math.min(waitMs + 200, 10_000)))
}

export async function getJupiterOrder(params: {
  inputMint: string
  outputMint: string
  amount: string
  /** Omit for price-only quotes; required to receive an assembled transaction. */
  taker?: string
  slippageBps?: number
  /** Comma-separated Jupiter venue labels, e.g. "Raydium,Raydium CLMM". */
  dexes?: string
  /** Comma-separated venues to exclude from Metis routing. */
  excludeDexes?: string
  /** Skip global rate-gap (parallel compare probes). Still respects 429 backoff. */
  bypassThrottle?: boolean
}): Promise<JupiterOrderResponse> {
  const started = Date.now()
  const isQuoteOnly = !params.taker?.trim()
  const cacheKey = `${params.inputMint}|${params.outputMint}|${params.amount}|${params.slippageBps ?? ''}|${params.dexes ?? ''}|${params.excludeDexes ?? ''}`

  if (isQuoteOnly) {
    const hit = quoteOrderCache.get(cacheKey)
    if (hit && Date.now() - hit.at < QUOTE_ORDER_TTL_MS) {
      return { ...hit.body, latencyMs: 0 }
    }
    if (isJupiterSwapRateLimited()) {
      const stale = resolveStaleQuote(cacheKey, params.inputMint, params.outputMint, params.amount)
      if (stale) return stale
      await waitForRateLimitWindow()
    }
  }

  if (!params.bypassThrottle) await throttleSwapOrderFetch()
  else if (!isJupiterSwapRateLimited()) lastOrderFetchAt = Date.now()

  const qs = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
  })
  if (params.taker?.trim()) qs.set('taker', params.taker.trim())
  if (params.slippageBps != null) qs.set('slippageBps', String(params.slippageBps))
  if (params.dexes?.trim()) qs.set('dexes', params.dexes.trim())
  if (params.excludeDexes?.trim()) qs.set('excludeDexes', params.excludeDexes.trim())
  qs.set('restrictIntermediateTokens', 'false')

  const maxAttempts = params.taker?.trim() ? 4 : 2
  let lastErr: Error | null = null
  let slippageBps = params.slippageBps

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (slippageBps != null) qs.set('slippageBps', String(slippageBps))
    const attemptUrl = `${apiBase()}/order?${qs.toString()}`
    try {
      const res = await fetch(attemptUrl, {
        headers: await jupiterHeaders(),
        signal: AbortSignal.timeout(25_000),
      })
      const body = (await res.json()) as JupiterOrderResponse & { error?: string; message?: string }

      if (res.status === 429) {
        swapRateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS
        logger.warn('[jupiter] swap /order rate limited (429) — backing off')
        if (isQuoteOnly) {
          const stale = resolveStaleQuote(cacheKey, params.inputMint, params.outputMint, params.amount)
          if (stale) return stale
        }
        if (attempt < maxAttempts) {
          await waitForRateLimitWindow()
          continue
        }
        throw new Error('[API Gateway] Too many requests — Jupiter swap API is rate-limited. Wait ~15s.')
      }

      if (!res.ok) {
        const msg = body.error ?? body.message ?? `Jupiter order HTTP ${res.status}`
        if (/too many requests|rate limit|429/i.test(msg)) {
          swapRateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS
          if (isQuoteOnly) {
            const stale = resolveStaleQuote(cacheKey, params.inputMint, params.outputMint, params.amount)
            if (stale) return stale
          }
          if (attempt < maxAttempts) {
            await waitForRateLimitWindow()
            continue
          }
        }
        const retryable = /failed to get quote|no route|liquidity|timeout|temporarily/i.test(msg)
        if (retryable && attempt < maxAttempts) {
          lastErr = new Error(msg)
          slippageBps = Math.min(2000, (slippageBps ?? 100) + 50 * attempt)
          await new Promise((r) => setTimeout(r, 450 * attempt))
          continue
        }
        throw new Error(msg)
      }

      const result = { ...body, latencyMs: Date.now() - started }
      if (isQuoteOnly) quoteOrderCache.set(cacheKey, { at: Date.now(), body: result })
      return result
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      if (attempt < maxAttempts) {
        const stale = isQuoteOnly
          ? resolveStaleQuote(cacheKey, params.inputMint, params.outputMint, params.amount)
          : null
        if (stale) return stale
        slippageBps = Math.min(2000, (slippageBps ?? 100) + 50 * attempt)
        await new Promise((r) => setTimeout(r, 450 * attempt))
        continue
      }
      throw lastErr
    }
  }

  throw lastErr ?? new Error('Jupiter order failed')
}

export async function submitJupiterExecute(params: {
  signedTransaction: string
  requestId: string
}): Promise<JupiterExecuteResponse> {
  const url = `${apiBase()}/execute`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...(await jupiterHeaders()),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      signedTransaction: params.signedTransaction,
      requestId: params.requestId,
    }),
    signal: AbortSignal.timeout(60_000),
  })
  const body = (await res.json()) as JupiterExecuteResponse & { error?: string; message?: string }
  if (!res.ok) {
    const msg = body.error ?? body.message ?? `Jupiter execute HTTP ${res.status}`
    throw new Error(msg)
  }
  if (body.status && body.status !== 'Success' && !body.signature) {
    logger.warn({ body }, '[jupiter] execute non-success')
    throw new Error(body.error ?? `Jupiter execute status: ${body.status}`)
  }
  return body
}
