/**
 * Jupiter Prediction Markets API (beta) — browse events, buy YES/NO, claim winnings.
 * https://developers.jup.ag/docs/guides/how-to-build-a-prediction-market-app-on-solana
 */
import { VersionedTransaction } from '@solana/web3.js'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import {
  ensureSolanaPersonalWallet,
  getSolanaKeypair,
  getSolanaTokenBalance,
  isSolanaWalletEnabled,
} from '../wallet/solanaPersonalWalletService'
import { withSolanaRpc } from '../solana/solanaRpcPool'
import { SOL_NATIVE_MINT } from '../../lib/solDexCatalog'
import { isJupiterConfigured } from './jupiterClassicService'

const PREDICTION_BASE = 'https://api.jup.ag/prediction/v1'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

export type JupiterPredictionMarket = {
  marketId: string
  status: string
  result: string | null
  metadata: {
    title: string
    status?: string
    /** When trading stops for this specific outcome. */
    closeTime?: string
    /** How the market settles, in Polymarket/Kalshi's own words. */
    rulesPrimary?: string
    rulesSecondary?: string
    /** Plain description of what makes this resolve YES. */
    closeCondition?: string
  }
  pricing: {
    buyYesPriceUsd: number | null
    buyNoPriceUsd: number | null
    sellYesPriceUsd?: number | null
    sellNoPriceUsd?: number | null
    volume?: number
  }
}

export type JupiterPredictionEvent = {
  eventId: string
  category: string
  isActive: boolean
  isLive: boolean
  /** Which venue's liquidity this is — Polymarket or Kalshi. */
  provider?: string
  metadata: {
    title: string
    subtitle?: string
    imageUrl?: string
    closeTime?: string
    rulesPrimary?: string
    closeCondition?: string
  }
  markets?: JupiterPredictionMarket[]
  volumeUsd?: string
}

export type JupiterPredictionPosition = {
  pubkey: string
  marketId: string
  isYes: boolean
  contracts: string
  avgPriceUsd: string
  totalCostUsd: string
  valueUsd: string | null
  pnlUsd: string | null
  pnlUsdPercent: number | null
  claimable: boolean
  claimed: boolean
  marketMetadata: { title: string }
  eventMetadata: { title: string }
}

type PredictionTxMeta = {
  blockhash?: string
  lastValidBlockHeight?: number
}

type PredictionTxResponse = {
  transaction?: string
  txMeta?: PredictionTxMeta
  data?: {
    transaction?: string
    txMeta?: PredictionTxMeta
  }
}

const MIN_SOL_FOR_PREDICT_TX = 0.005
const CONFIRM_TIMEOUT_MS = 90_000

function toMicroUsd(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : Number(v)
  return Number.isFinite(n) ? n : null
}

/** Optional string field that may be absent, null or empty on Jupiter's payload. */
function str(v: unknown): string | undefined {
  if (v == null) return undefined
  const s = String(v).trim()
  return s.length > 0 ? s : undefined
}

/** Jupiter occasionally omits nested objects; normalize so the UI never crashes. */
function normalizeMarket(raw: unknown): JupiterPredictionMarket | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const marketId = String(r.marketId ?? r.id ?? '').trim()
  if (!marketId) return null
  const meta = (r.metadata ?? {}) as Record<string, unknown>
  const pricingRaw = (r.pricing ?? {}) as Record<string, unknown>
  return {
    marketId,
    status: String(r.status ?? 'unknown'),
    result: r.result != null ? String(r.result) : null,
    metadata: {
      title: String(meta.title ?? meta.name ?? 'Market'),
      status: meta.status != null ? String(meta.status) : undefined,
      // These are what turn a bare strike label into a bet a user can judge,
      // so they are carried through even though the old UI ignored them.
      closeTime: str(meta.closeTime ?? meta.endTime ?? r.closeTime),
      rulesPrimary: str(meta.rulesPrimary ?? meta.rules ?? r.rulesPrimary),
      rulesSecondary: str(meta.rulesSecondary ?? r.rulesSecondary),
      closeCondition: str(meta.closeCondition ?? r.closeCondition),
    },
    pricing: {
      buyYesPriceUsd: toMicroUsd(pricingRaw.buyYesPriceUsd ?? pricingRaw.yesPrice),
      buyNoPriceUsd: toMicroUsd(pricingRaw.buyNoPriceUsd ?? pricingRaw.noPrice),
      sellYesPriceUsd: toMicroUsd(pricingRaw.sellYesPriceUsd),
      sellNoPriceUsd: toMicroUsd(pricingRaw.sellNoPriceUsd),
      volume: pricingRaw.volume != null ? Number(pricingRaw.volume) : undefined,
    },
  }
}

function normalizeEvent(raw: unknown): JupiterPredictionEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const eventId = String(r.eventId ?? r.id ?? '').trim()
  if (!eventId) return null
  const meta = (r.metadata ?? {}) as Record<string, unknown>
  const marketsRaw = Array.isArray(r.markets) ? r.markets : []
  const markets = marketsRaw
    .map((m) => normalizeMarket(m))
    .filter((m): m is JupiterPredictionMarket => m != null)
  return {
    eventId,
    category: String(r.category ?? 'other'),
    isActive: Boolean(r.isActive ?? true),
    isLive: Boolean(r.isLive ?? false),
    provider: str(r.provider ?? r.venue ?? r.source),
    metadata: {
      title: String(meta.title ?? meta.name ?? 'Event'),
      subtitle: str(meta.subtitle),
      imageUrl: str(meta.imageUrl),
      closeTime: str(meta.closeTime ?? meta.endTime),
      rulesPrimary: str(meta.rulesPrimary ?? meta.rules),
      closeCondition: str(meta.closeCondition),
    },
    markets,
    volumeUsd: r.volumeUsd != null ? String(r.volumeUsd) : undefined,
  }
}

function normalizePosition(raw: unknown): JupiterPredictionPosition | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const pubkey = String(r.pubkey ?? r.positionPubkey ?? '').trim()
  const marketId = String(r.marketId ?? '').trim()
  if (!pubkey || !marketId) return null
  const marketMeta = (r.marketMetadata ?? {}) as Record<string, unknown>
  const eventMeta = (r.eventMetadata ?? {}) as Record<string, unknown>
  return {
    pubkey,
    marketId,
    isYes: Boolean(r.isYes),
    contracts: String(r.contracts ?? '0'),
    avgPriceUsd: String(r.avgPriceUsd ?? '0'),
    totalCostUsd: String(r.totalCostUsd ?? '0'),
    valueUsd: r.valueUsd != null ? String(r.valueUsd) : null,
    pnlUsd: r.pnlUsd != null ? String(r.pnlUsd) : null,
    pnlUsdPercent: r.pnlUsdPercent != null ? Number(r.pnlUsdPercent) : null,
    claimable: Boolean(r.claimable),
    claimed: Boolean(r.claimed),
    marketMetadata: { title: String(marketMeta.title ?? marketId) },
    eventMetadata: { title: String(eventMeta.title ?? 'Event') },
  }
}

async function predictionFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (!isJupiterConfigured()) throw new Error('Jupiter API key not configured on server.')
  const key = env.JUPITER_API_KEY!.trim()
  const res = await fetch(`${PREDICTION_BASE}${path}`, {
    ...init,
    headers: {
      'x-api-key': key,
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(formatPredictionApiError(text, res.status))
  }
  return res.json() as Promise<T>
}

function formatPredictionApiError(raw: string, status: number): string {
  const trimmed = raw.trim()
  if (!trimmed) return `Prediction API error (${status})`
  try {
    const parsed = JSON.parse(trimmed) as {
      message?: string
      code?: string
      error?: string
    }
    const message = parsed.message ?? parsed.error
    const code = parsed.code ?? ''
    if (code === 'polymarket_quote_unavailable' || /liquidity is temporarily unavailable/i.test(message ?? '')) {
      return (
        'Polymarket exit liquidity is temporarily unavailable. ' +
        'Wait 1–2 minutes and click Sell / Close (not Claim) — your ~$15 USDC is still in the position.'
      )
    }
    if (message) return message
  } catch {
    /* not JSON */
  }
  return trimmed.slice(0, 240) || `Prediction API error (${status})`
}

function isPredictionLiquidityError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    /polymarket_quote_unavailable/i.test(msg) ||
    /liquidity is temporarily unavailable/i.test(msg) ||
    /exit liquidity/i.test(msg)
  )
}

const CLOSE_SLIPPAGE_BPS_STEPS = [2500, 4000, 6000, 8500] as const

async function requestCloseTransaction(
  ownerPubkey: string,
  positionPubkey: string,
  minSellPriceSlippageBps: number,
): Promise<{ transaction: string; txMeta?: PredictionTxMeta }> {
  const body = await predictionFetch<PredictionTxResponse>(
    `/positions/${encodeURIComponent(positionPubkey)}`,
    {
      method: 'DELETE',
      body: JSON.stringify({ ownerPubkey, minSellPriceSlippageBps }),
    },
  )
  return extractPredictionTransaction(body)
}

function microUsdToDisplay(micro: number | string | null | undefined): number | null {
  if (micro == null) return null
  const n = typeof micro === 'string' ? Number.parseInt(micro, 10) : micro
  if (!Number.isFinite(n)) return null
  return n / 1_000_000
}

export function formatMicroUsd(micro: number | string | null | undefined): number | null {
  return microUsdToDisplay(micro)
}

function extractPredictionTransaction(body: PredictionTxResponse): {
  transaction: string
  txMeta?: PredictionTxMeta
} {
  const transaction = String(body.transaction ?? body.data?.transaction ?? '').trim()
  if (!transaction) {
    throw new Error('Prediction API did not return a transaction.')
  }
  const txMeta = body.txMeta ?? body.data?.txMeta
  return { transaction, txMeta }
}

async function ensureSolForPredictTx(userId: string): Promise<void> {
  const sol = await getSolanaTokenBalance(userId, SOL_NATIVE_MINT, 9)
  if (sol >= MIN_SOL_FOR_PREDICT_TX) return
  throw new Error(
    `Solana wallet needs ~0.005 SOL for network fees (have ${sol.toFixed(4)} SOL). ` +
      `Deposit a little SOL to your Godslandx Solana wallet and retry.`,
  )
}

async function waitForSignatureConfirmation(
  conn: import('@solana/web3.js').Connection,
  signature: string,
  txMeta?: PredictionTxMeta,
  blockhashFromTx?: string,
): Promise<void> {
  const blockhash = txMeta?.blockhash ?? blockhashFromTx
  const lastValidBlockHeight = txMeta?.lastValidBlockHeight

  if (blockhash && lastValidBlockHeight != null) {
    const confirmation = await conn.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    )
    if (confirmation.value.err) {
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`)
    }
    return
  }

  const started = Date.now()
  while (Date.now() - started < CONFIRM_TIMEOUT_MS) {
    const statuses = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })
    const status = statuses.value[0]
    if (status?.err) {
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`)
    }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }

  throw new Error(
    `Transaction submitted but not confirmed within ${CONFIRM_TIMEOUT_MS / 1000}s. ` +
      `Check https://solscan.io/tx/${signature} — if it succeeded, refresh your positions.`,
  )
}

async function signAndSend(
  userId: string,
  transactionB64: string,
  txMeta?: PredictionTxMeta,
): Promise<string> {
  await ensureSolForPredictTx(userId)
  const kp = await getSolanaKeypair(userId)
  const txBuf = Buffer.from(transactionB64, 'base64')
  const vtx = VersionedTransaction.deserialize(txBuf)
  vtx.sign([kp])

  return withSolanaRpc(async (conn) => {
    let signature: string
    try {
      signature = await conn.sendRawTransaction(vtx.serialize(), {
        skipPreflight: false,
        maxRetries: 5,
        preflightCommitment: 'confirmed',
      })
    } catch (preflightErr) {
      logger.warn({ err: preflightErr, userId }, '[jupiter-predict] preflight failed — retrying send')
      signature = await conn.sendRawTransaction(vtx.serialize(), {
        skipPreflight: true,
        maxRetries: 5,
      })
    }

    await waitForSignatureConfirmation(conn, signature, txMeta, vtx.message.recentBlockhash)
    return signature
  })
}

export async function listJupiterPredictionEvents(opts?: {
  category?: string
  filter?: string
  limit?: number
}): Promise<{ events: JupiterPredictionEvent[]; updatedAt: string }> {
  const params = new URLSearchParams()
  params.set('includeMarkets', 'true')
  params.set('category', opts?.category ?? 'crypto')
  if (opts?.filter) params.set('filter', opts.filter)
  if (opts?.limit) params.set('limit', String(opts.limit))

  const body = await predictionFetch<{ data?: unknown[] }>(`/events?${params.toString()}`)
  const events = (body.data ?? [])
    .map((row) => normalizeEvent(row))
    .filter((e): e is JupiterPredictionEvent => e != null)
  return { events, updatedAt: new Date().toISOString() }
}

export async function searchJupiterPredictionEvents(
  query: string,
  limit = 12,
): Promise<{ events: JupiterPredictionEvent[] }> {
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    includeMarkets: 'true',
  })
  const body = await predictionFetch<{ data?: unknown[] }>(`/events/search?${params.toString()}`)
  const events = (body.data ?? [])
    .map((row) => normalizeEvent(row))
    .filter((e): e is JupiterPredictionEvent => e != null)
  return { events }
}

export async function getJupiterPredictionPositions(userId: string): Promise<{
  positions: JupiterPredictionPosition[]
  ownerPubkey: string
}> {
  if (!isSolanaWalletEnabled()) throw new Error('Solana wallet not configured.')
  await ensureSolanaPersonalWallet(userId)
  const kp = await getSolanaKeypair(userId)
  const ownerPubkey = kp.publicKey.toBase58()
  const body = await predictionFetch<{ data?: unknown[] }>(
    `/positions?ownerPubkey=${encodeURIComponent(ownerPubkey)}`,
  )
  const positions = (body.data ?? [])
    .map((row) => normalizePosition(row))
    .filter((p): p is JupiterPredictionPosition => p != null)
  return { positions, ownerPubkey }
}

export type JupiterPredictionHistoryEvent = {
  id: string
  timestamp: string
  action: string
  marketId?: string
  positionPubkey?: string
  isYes?: boolean
  amountUsd?: number
  costUsd?: number
  proceedsUsd?: number
  pnlUsd?: number
  title?: string
  txSignature?: string
}

function positionToLogMeta(p: JupiterPredictionPosition): Record<string, unknown> {
  const costUsd = (Number.parseInt(p.totalCostUsd, 10) || 0) / 1_000_000
  const proceedsUsd =
    p.valueUsd != null ? (Number.parseInt(p.valueUsd, 10) || 0) / 1_000_000 : undefined
  const pnlUsd = p.pnlUsd != null ? (Number.parseInt(p.pnlUsd, 10) || 0) / 1_000_000 : undefined
  return {
    marketId: p.marketId,
    positionPubkey: p.pubkey,
    title: p.marketMetadata?.title ?? p.eventMetadata?.title,
    isYes: p.isYes,
    costUsd,
    proceedsUsd,
    pnlUsd,
  }
}

function microFieldToUsd(v: unknown): number | undefined {
  if (v == null) return undefined
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : Number(v)
  if (!Number.isFinite(n)) return undefined
  return n / 1_000_000
}

function normalizeJupiterApiHistoryRow(raw: unknown): JupiterPredictionHistoryEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const signature = String(r.signature ?? r.txSignature ?? '').trim()
  const id = signature || String(r.id ?? r.orderPubkey ?? r.orderId ?? '').trim()
  if (!id) return null

  const ts = r.timestamp ?? r.createdAt ?? r.updatedAt
  let timestamp = new Date().toISOString()
  if (typeof ts === 'number') timestamp = new Date(ts > 1e12 ? ts : ts * 1000).toISOString()
  else if (typeof ts === 'string' && ts) timestamp = new Date(ts).toISOString()

  const eventType = String(r.eventType ?? r.status ?? '').toLowerCase()
  const isBuy = Boolean(r.isBuy)
  let action = 'UNKNOWN'
  if (eventType.includes('claim') || eventType.includes('payout')) action = 'CLAIM'
  else if (isBuy || eventType.includes('buy')) action = 'BUY'
  else if (!isBuy || eventType.includes('sell') || eventType.includes('fill')) action = 'SELL'

  const marketMeta = (r.marketMetadata ?? {}) as Record<string, unknown>
  const eventMeta = (r.eventMetadata ?? {}) as Record<string, unknown>
  const costUsd = microFieldToUsd(r.totalCostUsd ?? r.depositAmountUsd ?? r.orderCostUsd)
  const proceedsUsd = microFieldToUsd(
    r.netProceedsUsd ?? r.payoutAmountUsd ?? r.grossProceedsUsd ?? r.valueUsd,
  )
  const pnlUsd = microFieldToUsd(r.realizedPnl ?? r.realizedPnlBeforeFees ?? r.pnlUsd)

  return {
    id: `jup-${id}`,
    timestamp,
    action,
    marketId: r.marketId != null ? String(r.marketId) : undefined,
    positionPubkey: r.positionPubkey != null ? String(r.positionPubkey) : undefined,
    isYes: typeof r.isYes === 'boolean' ? r.isYes : undefined,
    amountUsd: action === 'BUY' ? costUsd ?? proceedsUsd : proceedsUsd ?? costUsd,
    costUsd,
    proceedsUsd,
    pnlUsd,
    title:
      marketMeta.title != null
        ? String(marketMeta.title)
        : eventMeta.title != null
          ? String(eventMeta.title)
          : undefined,
    txSignature: signature || undefined,
  }
}

async function fetchJupiterApiHistory(ownerPubkey: string): Promise<JupiterPredictionHistoryEvent[]> {
  const endpoints = [
    `/orders?ownerPubkey=${encodeURIComponent(ownerPubkey)}`,
    `/history?ownerPubkey=${encodeURIComponent(ownerPubkey)}`,
  ]
  for (const path of endpoints) {
    try {
      const body = await predictionFetch<{ data?: unknown[] }>(path)
      const rows = (body.data ?? [])
        .map((row) => normalizeJupiterApiHistoryRow(row))
        .filter((row): row is JupiterPredictionHistoryEvent => row != null)
      if (rows.length > 0) return rows
    } catch (err) {
      logger.warn({ err, ownerPubkey, path }, '[jupiter-predict] history endpoint unavailable')
    }
  }
  return []
}

function mergePredictHistory(
  dbEvents: JupiterPredictionHistoryEvent[],
  apiEvents: JupiterPredictionHistoryEvent[],
): JupiterPredictionHistoryEvent[] {
  const merged = new Map<string, JupiterPredictionHistoryEvent>()
  for (const event of [...apiEvents, ...dbEvents]) {
    const key = `${event.txSignature ?? event.id}:${event.action}`
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, event)
      continue
    }
    merged.set(key, {
      ...existing,
      ...event,
      costUsd: event.costUsd ?? existing.costUsd,
      proceedsUsd: event.proceedsUsd ?? existing.proceedsUsd,
      pnlUsd: event.pnlUsd ?? existing.pnlUsd,
      title: event.title ?? existing.title,
    })
  }
  return [...merged.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp))
}

export async function buyJupiterPrediction(
  userId: string,
  input: { marketId: string; isYes: boolean; amountUsd: number },
): Promise<{ txSignature: string; orderPubkey?: string }> {
  if (!isSolanaWalletEnabled()) throw new Error('Solana wallet not configured.')
  if (!Number.isFinite(input.amountUsd) || input.amountUsd < 1 || input.amountUsd > 500) {
    throw new Error('Amount must be between $1 and $500.')
  }

  await ensureSolanaPersonalWallet(userId)
  const kp = await getSolanaKeypair(userId)
  const depositAmount = String(Math.round(input.amountUsd * 1_000_000))

  const body = await predictionFetch<
    PredictionTxResponse & { order?: { orderPubkey?: string } }
  >('/orders', {
    method: 'POST',
    body: JSON.stringify({
      ownerPubkey: kp.publicKey.toBase58(),
      marketId: input.marketId,
      isYes: input.isYes,
      isBuy: true,
      depositAmount,
      depositMint: USDC_MINT,
    }),
  })

  const { transaction, txMeta } = extractPredictionTransaction(body)
  const txSignature = await signAndSend(userId, transaction, txMeta)
  logger.info(
    { userId, marketId: input.marketId, isYes: input.isYes, amountUsd: input.amountUsd, txSignature },
    '[jupiter-predict] buy submitted',
  )
  await logPredictEvent(userId, {
    action: 'BUY',
    marketId: input.marketId,
    isYes: input.isYes,
    amountUsd: input.amountUsd,
    txSignature,
    orderPubkey: body.order?.orderPubkey ?? null,
  })
  return { txSignature, orderPubkey: body.order?.orderPubkey }
}

/** Sell/close an open prediction position — returns USDC to the Solana wallet. */
export async function closeJupiterPredictionPosition(
  userId: string,
  positionPubkey: string,
  opts?: { minSellPriceSlippageBps?: number; logMeta?: Record<string, unknown> },
): Promise<{ txSignature: string }> {
  if (!isSolanaWalletEnabled()) throw new Error('Solana wallet not configured.')
  await ensureSolanaPersonalWallet(userId)
  const kp = await getSolanaKeypair(userId)
  const ownerPubkey = kp.publicKey.toBase58()

  let logMeta = opts?.logMeta
  if (!logMeta) {
    try {
      const { positions } = await getJupiterPredictionPositions(userId)
      const pos = positions.find((p) => p.pubkey === positionPubkey)
      if (pos) logMeta = positionToLogMeta(pos)
    } catch {
      /* optional snapshot */
    }
  }

  const slippageSteps =
    opts?.minSellPriceSlippageBps != null
      ? [opts.minSellPriceSlippageBps]
      : [...CLOSE_SLIPPAGE_BPS_STEPS]

  let lastErr: unknown
  for (const slippage of slippageSteps) {
    try {
      const { transaction, txMeta } = await requestCloseTransaction(
        ownerPubkey,
        positionPubkey,
        slippage,
      )
      const txSignature = await signAndSend(userId, transaction, txMeta)
      logger.info(
        { userId, positionPubkey, txSignature, slippageBps: slippage },
        '[jupiter-predict] close/sell submitted',
      )
      await logPredictEvent(userId, {
        action: 'SELL',
        positionPubkey,
        txSignature,
        slippageBps: slippage,
        ...logMeta,
        proceedsUsd: logMeta?.proceedsUsd ?? logMeta?.amountUsd,
      })
      return { txSignature }
    } catch (err) {
      lastErr = err
      if (!isPredictionLiquidityError(err)) throw err
      logger.warn(
        { userId, positionPubkey, slippageBps: slippage, err },
        '[jupiter-predict] close quote unavailable — retrying with wider slippage',
      )
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(
        'Could not exit prediction position — Polymarket liquidity is thin. Retry in a few minutes.',
      )
}

export async function claimJupiterPredictionPosition(
  userId: string,
  positionPubkey: string,
): Promise<{ txSignature: string; via?: 'claim' | 'sell_fallback' }> {
  if (!isSolanaWalletEnabled()) throw new Error('Solana wallet not configured.')
  await ensureSolanaPersonalWallet(userId)
  const kp = await getSolanaKeypair(userId)

  try {
    const body = await predictionFetch<PredictionTxResponse>(
      `/positions/${encodeURIComponent(positionPubkey)}/claim`,
      {
        method: 'POST',
        body: JSON.stringify({ ownerPubkey: kp.publicKey.toBase58() }),
      },
    )

    const { transaction, txMeta } = extractPredictionTransaction(body)
    const txSignature = await signAndSend(userId, transaction, txMeta)
    logger.info({ userId, positionPubkey, txSignature }, '[jupiter-predict] claim submitted')
    await logPredictEvent(userId, {
      action: 'CLAIM',
      positionPubkey,
      txSignature,
    })
    return { txSignature, via: 'claim' }
  } catch (err) {
    if (!isPredictionLiquidityError(err)) throw err
    logger.info(
      { userId, positionPubkey },
      '[jupiter-predict] claim liquidity unavailable — falling back to sell/close',
    )
    const sold = await closeJupiterPredictionPosition(userId, positionPubkey)
    return { txSignature: sold.txSignature, via: 'sell_fallback' }
  }
}

async function logPredictEvent(
  userId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const { prisma, ExecutionEventType } = await import('@cryptoflow/db')
    await prisma.executionEvent.create({
      data: {
        userId,
        eventType: ExecutionEventType.ORDER_SUBMITTED,
        payload: JSON.parse(JSON.stringify({ source: 'jupiter-predict', ...payload })),
      },
    })
  } catch (err) {
    logger.warn({ err }, '[jupiter-predict] failed to persist event')
  }
}

export async function getJupiterPredictionHistory(
  userId: string,
  limit = 50,
): Promise<{ events: JupiterPredictionHistoryEvent[] }> {
  const { prisma } = await import('@cryptoflow/db')
  await ensureSolanaPersonalWallet(userId)
  const kp = await getSolanaKeypair(userId)
  const ownerPubkey = kp.publicKey.toBase58()

  const rows = await prisma.executionEvent.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(400, Math.max(50, limit * 4)),
  })

  const dbEvents: JupiterPredictionHistoryEvent[] = rows
    .filter((r) => {
      const p = (r.payload ?? {}) as Record<string, unknown>
      return p.source === 'jupiter-predict'
    })
    .slice(0, Math.min(200, Math.max(1, limit)))
    .map((r) => {
    const p = (r.payload ?? {}) as Record<string, unknown>
    return {
      id: r.id,
      timestamp: r.createdAt.toISOString(),
      action: String(p.action ?? 'UNKNOWN'),
      marketId: p.marketId != null ? String(p.marketId) : undefined,
      positionPubkey: p.positionPubkey != null ? String(p.positionPubkey) : undefined,
      isYes: typeof p.isYes === 'boolean' ? p.isYes : undefined,
      amountUsd: typeof p.amountUsd === 'number' ? p.amountUsd : undefined,
      costUsd: typeof p.costUsd === 'number' ? p.costUsd : undefined,
      proceedsUsd: typeof p.proceedsUsd === 'number' ? p.proceedsUsd : undefined,
      pnlUsd: typeof p.pnlUsd === 'number' ? p.pnlUsd : undefined,
      title: p.title != null ? String(p.title) : undefined,
      txSignature: p.txSignature != null ? String(p.txSignature) : undefined,
    }
  })

  const apiEvents = await fetchJupiterApiHistory(ownerPubkey)
  const events = mergePredictHistory(dbEvents, apiEvents).slice(0, Math.min(200, Math.max(1, limit)))
  return { events }
}
