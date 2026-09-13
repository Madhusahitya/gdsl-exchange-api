/**
 * Execution Engine — parallel router quotes + scoring.
 *
 * Additive layer: existing Jupiter Metis execute path remains the fallback.
 * We compare Metis + venue-restricted Jupiter routes + OKX DEX quotes, score them,
 * and optionally prefer the best Jupiter-executable route on swap.
 *
 * Score weights (user spec):
 *   50% output · 20% speed · 15% price impact · 10% historical fill · 5% MEV risk
 */
import { SOL_USDC_MINT, SOL_NATIVE_MINT } from '../../lib/solDexCatalog'
import { logger } from '../../lib/logger'
import { getJupiterOrder, isJupiterConfigured, isJupiterSwapRateLimited } from './jupiterClassicService'
import { getJupiterTradableToken } from './jupiterTradableRegistry'
import { getSolanaRpcStats, type RpcEndpointStats } from '../solana/solanaRpcPool'

export type RouterId =
  | 'jupiter-metis'
  | 'raydium'
  | 'orca'
  | 'meteora'
  | 'phoenix'
  | 'openbook'
  | 'sanctum'
  | 'pumpswap'
  | 'lifinity'
  | 'crema'
  | 'fluxbeam'
  | 'goosefx'
  | 'okx-dex'

export type RouteCandidate = {
  router: RouterId
  label: string
  /** Human out amount (token for BUY, USDC for SELL). */
  outAmount: number
  inAmount: number
  latencyMs: number
  priceImpactPct: number | null
  /** 0–100 composite score. */
  score: number
  executable: boolean
  /** Jupiter can assemble/sign this route today. */
  canExecute: boolean
  error?: string
  /** Jupiter dexes= filter used (if any). */
  dexes?: string
  explanation: string
  /** Venues seen in Jupiter routePlan (when available). */
  venues?: string[]
}

export type CexReference = {
  binance: number | null
  okx: number | null
  bybit: number | null
}

export type ExecutionCompareResult = {
  side: 'BUY' | 'SELL'
  binanceSymbol: string
  amountIn: number
  amountInRaw: string
  inputMint: string
  outputMint: string
  best: RouteCandidate | null
  routes: RouteCandidate[]
  cex: CexReference
  rpc: RpcEndpointStats[]
  aiExplanation: string
  confidence: {
    overall: number
    liquidity: number
    execution: number
    spread: number
    momentum: number
  }
  generatedAt: string
}

/** Primary venues probed on every Buy/Sell compare (fast path). */
const PRIMARY_ROUTER_FILTERS: Partial<Record<RouterId, { label: string; dexes: string }>> = {
  raydium: { label: 'Raydium direct', dexes: 'Raydium,Raydium CLMM,Raydium CP' },
  orca: { label: 'Orca direct', dexes: 'Orca V1,Orca V2,Whirlpool' },
  meteora: { label: 'Meteora direct', dexes: 'Meteora,Meteora DLMM' },
}

/** Secondary / order-book venues — shown in Router tab, not every execute. */
const SECONDARY_ROUTER_FILTERS: Partial<Record<RouterId, { label: string; dexes: string }>> = {
  phoenix: { label: 'Phoenix order book', dexes: 'Phoenix' },
  openbook: { label: 'OpenBook order book', dexes: 'OpenBook,OpenBook V2' },
  sanctum: { label: 'Sanctum', dexes: 'Sanctum,Sanctum Infinity' },
  pumpswap: { label: 'PumpSwap', dexes: 'Pump.fun,Pump.fun Amm' },
  lifinity: { label: 'Lifinity', dexes: 'Lifinity,Lifinity V2' },
  crema: { label: 'Crema', dexes: 'Crema' },
  fluxbeam: { label: 'FluxBeam', dexes: 'FluxBeam' },
  goosefx: { label: 'GooseFX', dexes: 'GooseFX' },
}

type RouteMemory = {
  samples: number
  avgLatencyMs: number
  failRate: number
  wins: Record<string, number>
}

const routeMemory = new Map<string, RouteMemory>()

function memKey(mint: string, side: string): string {
  return `${mint}:${side}`
}

export function recordRouteOutcome(opts: {
  mint: string
  side: 'BUY' | 'SELL'
  router: RouterId
  latencyMs: number
  success: boolean
}): void {
  const key = memKey(opts.mint, opts.side)
  const cur = routeMemory.get(key) ?? { samples: 0, avgLatencyMs: 0, failRate: 0, wins: {} }
  const n = cur.samples + 1
  cur.avgLatencyMs = (cur.avgLatencyMs * cur.samples + opts.latencyMs) / n
  cur.failRate = (cur.failRate * cur.samples + (opts.success ? 0 : 1)) / n
  if (opts.success) cur.wins[opts.router] = (cur.wins[opts.router] ?? 0) + 1
  cur.samples = n
  routeMemory.set(key, cur)
}

function historicalFillScore(mint: string, side: 'BUY' | 'SELL', router: RouterId): number {
  const mem = routeMemory.get(memKey(mint, side))
  if (!mem || mem.samples < 3) return 0.7
  const totalWins = Object.values(mem.wins).reduce((a, b) => a + b, 0) || 1
  const share = (mem.wins[router] ?? 0) / totalWins
  return Math.max(0.2, Math.min(1, 0.4 + share * 0.6)) * (1 - mem.failRate * 0.5)
}

function toSmallest(amount: number, decimals: number): string {
  const raw = Math.floor(amount * 10 ** decimals)
  return String(Math.max(1, raw))
}

function fromSmallest(raw: string, decimals: number): number {
  return Number(raw) / 10 ** decimals
}

function extractVenues(routePlan: unknown): string[] {
  if (!Array.isArray(routePlan)) return []
  const out: string[] = []
  for (const hop of routePlan) {
    const label =
      (hop as { swapInfo?: { label?: string }; label?: string })?.swapInfo?.label ??
      (hop as { label?: string })?.label
    if (label && !out.includes(label)) out.push(label)
  }
  return out
}

async function fetchCexMids(binanceSymbol: string): Promise<CexReference> {
  const sym = binanceSymbol.toUpperCase()
  const [binance, okx, bybit] = await Promise.all([
    fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(sym)}`, {
      signal: AbortSignal.timeout(2500),
    })
      .then(async (r) => {
        if (!r.ok) return null
        const j = (await r.json()) as { price?: string }
        const p = j.price ? parseFloat(j.price) : NaN
        return Number.isFinite(p) && p > 0 ? p : null
      })
      .catch(() => null),
    fetch(`https://www.okx.com/api/v5/market/ticker?instId=${sym.replace(/USDT$/, '')}-USDT`, {
      signal: AbortSignal.timeout(2500),
    })
      .then(async (r) => {
        if (!r.ok) return null
        const j = (await r.json()) as { data?: Array<{ last?: string }> }
        const p = j.data?.[0]?.last ? parseFloat(j.data[0].last) : NaN
        return Number.isFinite(p) && p > 0 ? p : null
      })
      .catch(() => null),
    fetch(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${encodeURIComponent(sym)}`, {
      signal: AbortSignal.timeout(2500),
    })
      .then(async (r) => {
        if (!r.ok) return null
        const j = (await r.json()) as { result?: { list?: Array<{ lastPrice?: string }> } }
        const p = j.result?.list?.[0]?.lastPrice ? parseFloat(j.result.list[0].lastPrice) : NaN
        return Number.isFinite(p) && p > 0 ? p : null
      })
      .catch(() => null),
  ])
  return { binance, okx, bybit }
}

async function quoteOkxDex(opts: {
  side: 'BUY' | 'SELL'
  fromMint: string
  toMint: string
  amountRaw: string
}): Promise<{ outAmount: number; latencyMs: number } | null> {
  const started = Date.now()
  try {
    // OKX DEX aggregator — Solana chainId 501
    const qs = new URLSearchParams({
      chainId: '501',
      fromTokenAddress: opts.fromMint === SOL_NATIVE_MINT ? '11111111111111111111111111111111' : opts.fromMint,
      toTokenAddress: opts.toMint === SOL_NATIVE_MINT ? '11111111111111111111111111111111' : opts.toMint,
      amount: opts.amountRaw,
      swapMode: 'exactIn',
    })
    const res = await fetch(`https://www.okx.com/api/v5/dex/aggregator/quote?${qs}`, {
      signal: AbortSignal.timeout(5_000),
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    const body = (await res.json()) as {
      code?: string
      data?: Array<{ toTokenAmount?: string; toToken?: { decimal?: string } }>
    }
    if (body.code !== '0' || !body.data?.[0]?.toTokenAmount) return null
    const decimals = Number(body.data[0].toToken?.decimal ?? (opts.side === 'BUY' ? 9 : 6))
    const out = Number(body.data[0].toTokenAmount) / 10 ** decimals
    if (!Number.isFinite(out) || out <= 0) return null
    return { outAmount: out, latencyMs: Date.now() - started }
  } catch {
    return null
  }
}

function scoreRoute(opts: {
  outAmount: number
  bestOut: number
  latencyMs: number
  priceImpactPct: number | null
  histFill: number
  mevRisk: number
}): number {
  const outputScore = opts.bestOut > 0 ? Math.min(1, opts.outAmount / opts.bestOut) : 0
  // Faster is better: 100ms → 1.0, 1500ms → ~0.2
  const speedScore = Math.max(0.15, Math.min(1, 1 - (opts.latencyMs - 80) / 1_600))
  const impact = Math.abs(opts.priceImpactPct ?? 0.15)
  const impactScore = Math.max(0.1, Math.min(1, 1 - impact / 2))
  const mevScore = Math.max(0, 1 - opts.mevRisk)
  return (
    100 *
    (0.5 * outputScore +
      0.2 * speedScore +
      0.15 * impactScore +
      0.1 * opts.histFill +
      0.05 * mevScore)
  )
}

function mevRiskFor(router: RouterId): number {
  // Direct AMM / CLOB typically lower aggregator MEV surface than multi-hop Metis.
  if (router === 'jupiter-metis') return 0.35
  if (router === 'okx-dex') return 0.3
  if (router === 'phoenix' || router === 'openbook') return 0.15
  return 0.22
}

const compareCache = new Map<string, { at: number; body: ExecutionCompareResult }>()
const COMPARE_CACHE_MS = 5_000
const COMPARE_STALE_MS = 45_000

export async function compareExecutionRoutes(opts: {
  side: 'BUY' | 'SELL'
  binanceSymbol: string
  amount: number
  spendMint?: string
  slippageBps?: number
  /** Include Phoenix/OpenBook/Sanctum/… probes (Router tab). Default false for fast Buy path. */
  includeSecondary?: boolean
}): Promise<ExecutionCompareResult> {
  if (!isJupiterConfigured()) {
    throw new Error('Jupiter API key not configured')
  }

  const cacheKey = `${opts.side}|${opts.binanceSymbol}|${opts.amount}|${opts.slippageBps ?? ''}|${opts.spendMint ?? ''}|${opts.includeSecondary ? 1 : 0}`
  const cached = compareCache.get(cacheKey)
  if (cached && Date.now() - cached.at < COMPARE_CACHE_MS) return cached.body
  if (cached && Date.now() - cached.at < COMPARE_STALE_MS && isJupiterSwapRateLimited()) {
    return cached.body
  }
  const token = await getJupiterTradableToken(opts.binanceSymbol)
  if (!token) throw new Error(`Unsupported symbol ${opts.binanceSymbol}`)

  const side = opts.side
  const spendMint = opts.spendMint?.trim() || SOL_USDC_MINT
  const inputMint = side === 'BUY' ? spendMint : token.mint
  const outputMint = side === 'BUY' ? token.mint : SOL_USDC_MINT
  const inDecimals =
    side === 'BUY'
      ? spendMint === SOL_NATIVE_MINT
        ? 9
        : spendMint === SOL_USDC_MINT
          ? 6
          : 6
      : token.decimals
  const amountRaw = toSmallest(opts.amount, inDecimals)
  const slippageBps = opts.slippageBps ?? 100

  const [cex, rpc] = await Promise.all([fetchCexMids(token.binanceSymbol), getSolanaRpcStats()])

  type Raw = {
    router: RouterId
    label: string
    outAmount: number
    inAmount: number
    latencyMs: number
    priceImpactPct: number | null
    canExecute: boolean
    dexes?: string
    venues?: string[]
    error?: string
  }

  const jobs: Array<Promise<Raw>> = []

  jobs.push(
    (async (): Promise<Raw> => {
      const started = Date.now()
      try {
        const order = await getJupiterOrder({
          inputMint,
          outputMint,
          amount: amountRaw,
          slippageBps,
        })
        const outDecimals = side === 'BUY' ? token.decimals : 6
        return {
          router: 'jupiter-metis',
          label: 'Jupiter Metis',
          outAmount: fromSmallest(order.outAmount, outDecimals),
          inAmount: fromSmallest(order.inAmount ?? amountRaw, inDecimals),
          latencyMs: order.latencyMs ?? Date.now() - started,
          priceImpactPct: order.priceImpactPct != null ? parseFloat(String(order.priceImpactPct)) : null,
          canExecute: true,
          venues: extractVenues(order.routePlan),
        }
      } catch (err) {
        return {
          router: 'jupiter-metis',
          label: 'Jupiter Metis',
          outAmount: 0,
          inAmount: opts.amount,
          latencyMs: Date.now() - started,
          priceImpactPct: null,
          canExecute: true,
          error: err instanceof Error ? err.message : 'quote failed',
        }
      }
    })(),
  )

  const filters = {
    ...PRIMARY_ROUTER_FILTERS,
    ...(opts.includeSecondary ? SECONDARY_ROUTER_FILTERS : {}),
  }

  for (const [router, meta] of Object.entries(filters) as Array<[RouterId, { label: string; dexes: string }]>) {
    jobs.push(
      (async (): Promise<Raw> => {
        const started = Date.now()
        try {
          const order = await getJupiterOrder({
            inputMint,
            outputMint,
            amount: amountRaw,
            slippageBps,
            dexes: meta.dexes,
          })
          const outDecimals = side === 'BUY' ? token.decimals : 6
          return {
            router,
            label: meta.label,
            outAmount: fromSmallest(order.outAmount, outDecimals),
            inAmount: fromSmallest(order.inAmount ?? amountRaw, inDecimals),
            latencyMs: order.latencyMs ?? Date.now() - started,
            priceImpactPct: order.priceImpactPct != null ? parseFloat(String(order.priceImpactPct)) : null,
            canExecute: true,
            dexes: meta.dexes,
            venues: extractVenues(order.routePlan),
          }
        } catch (err) {
          return {
            router,
            label: meta.label,
            outAmount: 0,
            inAmount: opts.amount,
            latencyMs: Date.now() - started,
            priceImpactPct: null,
            canExecute: true,
            dexes: meta.dexes,
            error: err instanceof Error ? err.message : 'no route',
          }
        }
      })(),
    )
  }

  jobs.push(
    (async (): Promise<Raw> => {
      const q = await quoteOkxDex({ side, fromMint: inputMint, toMint: outputMint, amountRaw })
      if (!q) {
        return {
          router: 'okx-dex',
          label: 'OKX DEX',
          outAmount: 0,
          inAmount: opts.amount,
          latencyMs: 0,
          priceImpactPct: null,
          canExecute: false,
          error: 'No OKX route',
        }
      }
      return {
        router: 'okx-dex',
        label: 'OKX DEX',
        outAmount: q.outAmount,
        inAmount: opts.amount,
        latencyMs: q.latencyMs,
        priceImpactPct: null,
        canExecute: false,
      }
    })(),
  )

  const raws = await Promise.all(jobs)
  const bestOut = Math.max(0, ...raws.filter((r) => r.outAmount > 0).map((r) => r.outAmount))

  const routes: RouteCandidate[] = raws.map((r) => {
    const executable = r.outAmount > 0 && !r.error
    const hist = historicalFillScore(token.mint, side, r.router)
    const score = executable
      ? scoreRoute({
          outAmount: r.outAmount,
          bestOut: bestOut || r.outAmount,
          latencyMs: r.latencyMs,
          priceImpactPct: r.priceImpactPct,
          histFill: hist,
          mevRisk: mevRiskFor(r.router),
        })
      : 0
    const vsBest =
      bestOut > 0 && r.outAmount > 0 ? ((r.outAmount - bestOut) / bestOut) * 100 : null
    const explanation = !executable
      ? r.error ?? 'No route'
      : vsBest != null && vsBest >= -0.02
        ? `Best-in-class output · ${r.latencyMs}ms · impact ${r.priceImpactPct?.toFixed(3) ?? '—'}%`
        : `Output ${vsBest?.toFixed(3)}% vs best · ${r.latencyMs}ms · hist fill ${(hist * 100).toFixed(0)}%`
    return {
      router: r.router,
      label: r.label,
      outAmount: r.outAmount,
      inAmount: r.inAmount,
      latencyMs: r.latencyMs,
      priceImpactPct: r.priceImpactPct,
      score: Math.round(score * 10) / 10,
      executable,
      canExecute: r.canExecute && executable,
      error: r.error,
      dexes: r.dexes,
      venues: r.venues,
      explanation,
    }
  })

  routes.sort((a, b) => b.score - a.score)
  const best = routes.find((r) => r.canExecute) ?? routes.find((r) => r.executable) ?? null

  const ref = cex.binance ?? cex.okx ?? cex.bybit
  const execPx =
    best && best.inAmount > 0 && best.outAmount > 0
      ? side === 'BUY'
        ? best.inAmount / best.outAmount
        : best.outAmount / best.inAmount
      : null
  const spreadBps =
    ref && execPx && ref > 0 ? Math.round(((execPx - ref) / ref) * 10_000) : null

  const liquidity = Math.min(98, 55 + routes.filter((r) => r.executable).length * 4)
  const execution = best ? Math.min(99, Math.round(best.score)) : 20
  const spreadScore =
    spreadBps == null ? 70 : Math.max(20, Math.min(99, 95 - Math.abs(spreadBps) / 2))
  const momentum = 72
  const overall = Math.round(0.35 * execution + 0.25 * liquidity + 0.25 * spreadScore + 0.15 * momentum)

  const aiExplanation = best
    ? `Best executable: ${best.label} (score ${best.score}). ` +
      `Output ${best.outAmount.toPrecision(6)} in ${best.latencyMs}ms` +
      (spreadBps != null ? ` · vs CEX ${spreadBps >= 0 ? '+' : ''}${spreadBps} bps` : '') +
      `. Ranked by 50% output / 20% speed / 15% impact / 10% history / 5% MEV. ` +
      (best.router === 'jupiter-metis'
        ? 'Metis won — multi-hop liquidity beats single-venue depth right now.'
        : `${best.label} beat Metis on this size — prefer direct venue for lower latency/MEV.`)
    : 'No executable route right now — keep using Jupiter Metis when liquidity returns.'

  logger.debug(
    { symbol: token.binanceSymbol, side, best: best?.router, score: best?.score },
    '[execution-engine] compare',
  )

  const result: ExecutionCompareResult = {
    side,
    binanceSymbol: token.binanceSymbol,
    amountIn: opts.amount,
    amountInRaw: amountRaw,
    inputMint,
    outputMint,
    best,
    routes,
    cex,
    rpc,
    aiExplanation,
    confidence: {
      overall,
      liquidity,
      execution,
      spread: Math.round(spreadScore),
      momentum,
    },
    generatedAt: new Date().toISOString(),
  }

  compareCache.set(cacheKey, { at: Date.now(), body: result })
  return result
}

/** Pick best Jupiter-executable dex filter for a live swap (null = unrestricted Metis). */
export async function pickBestJupiterDexFilter(opts: {
  side: 'BUY' | 'SELL'
  binanceSymbol: string
  amount: number
  spendMint?: string
  slippageBps?: number
}): Promise<{ dexes?: string; router: RouterId; explanation: string } | null> {
  try {
    const cmp = await compareExecutionRoutes(opts)
    const best = cmp.routes.find((r) => r.canExecute)
    if (!best) return null
    recordRouteOutcome({
      mint: cmp.inputMint === SOL_USDC_MINT || cmp.inputMint === SOL_NATIVE_MINT ? cmp.outputMint : cmp.inputMint,
      side: opts.side,
      router: best.router,
      latencyMs: best.latencyMs,
      success: true,
    })
    return {
      dexes: best.dexes,
      router: best.router,
      explanation: cmp.aiExplanation,
    }
  } catch (err) {
    logger.warn({ err }, '[execution-engine] pickBest failed — falling back to Metis')
    return null
  }
}
