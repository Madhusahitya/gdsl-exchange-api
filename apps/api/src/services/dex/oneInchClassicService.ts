/**
 * 1inch Classic Swap API (BSC chain 56) — quote + swap calldata.
 * Docs: https://business.1inch.com/portal/documentation/apis/swap/classic-swap
 */
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'

export const ONEINCH_CHAIN_ID = 56
const ONEINCH_BASE = `https://api.1inch.com/swap/v6.1/${ONEINCH_CHAIN_ID}`
export const ONEINCH_USDT = '0x55d398326f99059ff775485246999027b3197955' as const
export const ONEINCH_NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as const

export type OneInchTokenMeta = {
  symbol: string
  address: `0x${string}`
  decimals: number
}

let tokenMapCache: { at: number; bySymbol: Map<string, OneInchTokenMeta> } | null = null
const TOKEN_MAP_TTL_MS = 60 * 60 * 1000

export function isOneInchConfigured(): boolean {
  return Boolean(env.ONEINCH_API_KEY?.trim())
}

function apiKey(): string {
  const k = env.ONEINCH_API_KEY?.trim()
  if (!k) throw new Error('1inch API is not configured (ONEINCH_API_KEY missing on server).')
  return k
}

async function inchGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${ONEINCH_BASE}${path}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, v)
  }
  const started = Date.now()
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(12_000),
  })
  const ms = Date.now() - started
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { description?: string; error?: string; message?: string }
      detail = body.description ?? body.error ?? body.message ?? detail
    } catch {
      /* ignore */
    }
    logger.warn({ path, status: res.status, ms, detail }, '[1inch] API error')
    throw new Error(detail || `1inch API error ${res.status}`)
  }
  logger.debug({ path, ms }, '[1inch] OK')
  return (await res.json()) as T
}

export async function fetchOneInchTokenMap(): Promise<Map<string, OneInchTokenMeta>> {
  const now = Date.now()
  if (tokenMapCache && now - tokenMapCache.at < TOKEN_MAP_TTL_MS) {
    return tokenMapCache.bySymbol
  }
  type TokensPayload = {
    tokens?: Record<string, { symbol?: string; decimals?: number; address?: string }>
  }
  const data = await inchGet<TokensPayload>('/tokens', {})
  const bySymbol = new Map<string, OneInchTokenMeta>()
  const tokens = data.tokens ?? {}
  for (const entry of Object.values(tokens)) {
    const sym = entry.symbol?.trim().toUpperCase()
    const addr = (entry.address ?? '').toLowerCase() as `0x${string}` | undefined
    const dec = entry.decimals
    if (!sym || !addr || !/^0x[a-f0-9]{40}$/.test(addr) || typeof dec !== 'number') continue
    bySymbol.set(sym, { symbol: sym, address: addr, decimals: dec })
  }
  tokenMapCache = { at: now, bySymbol }
  return bySymbol
}

export type OneInchQuoteResult = {
  srcToken: string
  dstToken: string
  srcAmount: string
  dstAmount: string
  /** Estimated gas units from 1inch. */
  gas: number | null
  latencyMs: number
}

export async function getOneInchQuote(params: {
  src: string
  dst: string
  amount: string
}): Promise<OneInchQuoteResult> {
  const started = Date.now()
  const q = await inchGet<{ dstAmount?: string; gas?: number }>('/quote', {
    src: params.src,
    dst: params.dst,
    amount: params.amount,
  })
  return {
    srcToken: params.src,
    dstToken: params.dst,
    srcAmount: params.amount,
    dstAmount: String(q.dstAmount ?? '0'),
    gas: typeof q.gas === 'number' ? q.gas : null,
    latencyMs: Date.now() - started,
  }
}

export type OneInchSwapTx = {
  from: string
  to: string
  data: string
  value: string
  gas: number | null
  gasPrice: string | null
}

export type OneInchSwapBuild = {
  dstAmount: string
  tx: OneInchSwapTx
  latencyMs: number
}

export async function buildOneInchSwap(params: {
  src: string
  dst: string
  amount: string
  from: string
  slippagePercent: number
}): Promise<OneInchSwapBuild> {
  const started = Date.now()
  const slippage = Math.min(50, Math.max(0.1, params.slippagePercent))
  const data = await inchGet<{ dstAmount?: string; tx?: OneInchSwapTx }>('/swap', {
    src: params.src,
    dst: params.dst,
    amount: params.amount,
    from: params.from,
    slippage: String(slippage),
    disableEstimate: 'true',
  })
  if (!data.tx?.to || !data.tx?.data) {
    throw new Error('1inch did not return executable swap data for this pair.')
  }
  return {
    dstAmount: String(data.dstAmount ?? '0'),
    tx: data.tx,
    latencyMs: Date.now() - started,
  }
}

let spenderCache: { at: number; address: string } | null = null
const SPENDER_TTL_MS = 24 * 60 * 60 * 1000

/** 1inch router address tokens must approve before swap. */
export async function getOneInchSpender(): Promise<string> {
  const now = Date.now()
  if (spenderCache && now - spenderCache.at < SPENDER_TTL_MS) {
    return spenderCache.address
  }
  const data = await inchGet<{ address?: string }>('/approve/spender', {})
  const addr = data.address?.toLowerCase()
  if (!addr || !/^0x[a-f0-9]{40}$/.test(addr)) {
    throw new Error('1inch approve spender unavailable')
  }
  spenderCache = { at: now, address: addr }
  return addr
}

export async function buildOneInchApproveTx(params: {
  tokenAddress: string
  amount: string
}): Promise<OneInchSwapTx> {
  const data = await inchGet<{ to?: string; data?: string; value?: string; gas?: number; gasPrice?: string }>(
    '/approve/transaction',
    {
      tokenAddress: params.tokenAddress,
      amount: params.amount,
    },
  )
  if (!data.to || !data.data) throw new Error('1inch approve transaction unavailable')
  return {
    from: '',
    to: data.to,
    data: data.data,
    value: data.value ?? '0',
    gas: data.gas ?? null,
    gasPrice: data.gasPrice ?? null,
  }
}
