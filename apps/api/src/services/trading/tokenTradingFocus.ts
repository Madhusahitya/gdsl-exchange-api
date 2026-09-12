import { InboxCategory } from '@cryptoflow/db'
import { computeTrendRsiSignal } from '../../lib/dexSignalMath'
import { createInboxMessage, recentDedupeExists } from '../inbox/inboxService'
import { getPersonalWalletSummary, isPersonalWalletEnabled } from '../wallet/personalWalletService'

export type FocusWalletPayload = {
  mode: 'personal' | 'external'
  label?: string
  addressTail?: string
  usdtBalance?: number
  baseUsdApprox?: number
}

// Binance spot bases can be as short as 2-3 chars (e.g. SOLUSDT, BTCUSDT).
const BINANCE_SYMBOL_RE = /^[A-Z0-9]{2,24}USDT$/

async function fetchKlineCloses(binanceSymbol: string, limit = 40): Promise<number[]> {
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(binanceSymbol)}&interval=1m&limit=${limit}`,
    )
    if (!res.ok) return []
    const rows = (await res.json()) as unknown[]
    if (!Array.isArray(rows)) return []
    const closes: number[] = []
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 5) continue
      const close = typeof row[4] === 'string' ? parseFloat(row[4]) : NaN
      if (Number.isFinite(close) && close > 0) closes.push(close)
    }
    return closes
  } catch {
    return []
  }
}

function baseAsset(symbol: string): string {
  return symbol.replace(/USDT$/, '')
}

function fmtPrice(p: number): string {
  if (!Number.isFinite(p)) return '—'
  if (p >= 1000) return p.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (p >= 1) return p.toFixed(4)
  return p.toPrecision(6)
}

const BODY_PLAIN_TECH_SPLIT = '\n---\n'

async function resolveWalletSnapshot(
  userId: string,
  base: string,
  incoming?: FocusWalletPayload,
): Promise<{
  usdt: number
  baseUsd: number
  technicalLine: string
  plainTitle: string
  dedupeSuffix: string
}> {
  const mode = incoming?.mode ?? 'personal'

  if (mode === 'external') {
    const usdt = incoming?.usdtBalance ?? 0
    const baseUsd = incoming?.baseUsdApprox ?? 0
    const label = incoming?.label?.trim() || 'Connected wallet'
    const tail = incoming?.addressTail ? ` …${incoming.addressTail}` : ''
    const technicalLine = `${label}${tail}: ~${usdt.toFixed(2)} USDT · ~$${baseUsd.toFixed(2)} ${base} (from your browser wallet on BSC).`
    return {
      usdt,
      baseUsd,
      technicalLine,
      plainTitle: label,
      dedupeSuffix: `ext:${label}`,
    }
  }

  if (isPersonalWalletEnabled()) {
    const summary = await getPersonalWalletSummary(userId)
    if (summary) {
      const usdt = summary.balances.find((b) => b.asset === 'USDT')?.amount ?? 0
      const mapBtc = (s: string) => (s === 'BTC' ? 'BTCB' : s)
      const asset = mapBtc(base)
      const pos = summary.balances.find((b) => b.asset === asset)
      const baseUsd = pos?.usdValue ?? 0
      const technicalLine = `Personal Wallet: ~${usdt.toFixed(2)} USDT · ~$${baseUsd.toFixed(2)} ${base}.`
      return {
        usdt,
        baseUsd,
        technicalLine,
        plainTitle: 'Personal Wallet',
        dedupeSuffix: 'personal',
      }
    }
  }

  return {
    usdt: 0,
    baseUsd: 0,
    technicalLine: 'Wallet balances unavailable (enable Personal Wallet or connect MetaMask on BSC).',
    plainTitle: 'Personal Wallet',
    dedupeSuffix: 'personal',
  }
}

/** Compact plain-language block for inbox + toast. */
function buildPlainEnglishBlock(input: {
  signal: 'BUY' | 'SELL' | 'HOLD'
  base: string
  refPrice: number
  buyRef: number
  sellRef: number
  usdt: number
  baseUsdValue: number
  scoutChain: string
  scoutVenue: string
  walletPlainTitle: string
}): string {
  const { signal, base, refPrice, buyRef, sellRef, usdt, baseUsdValue, scoutChain, scoutVenue, walletPlainTitle } =
    input
  const last = fmtPrice(refPrice)
  const buyZ = fmtPrice(buyRef)
  const sellZ = fmtPrice(sellRef)

  let headline = ''
  if (signal === 'HOLD') {
    headline = `HOLD - No strong short-term buy/sell cue on ${base} (Binance ref ~${last} USDT).`
  } else if (signal === 'BUY') {
    headline = `BUY lean - Model tilts toward buying ${base} (~${last} USDT; band ~${buyZ}-${sellZ}). Ideas only.`
  } else {
    headline = `SELL lean - Model tilts toward trimming ${base} (~${last} USDT; band ~${buyZ}-${sellZ}). Ideas only.`
  }

  const lines = [
    headline,
    ``,
    `Balances (${walletPlainTitle}): ~${usdt.toFixed(2)} USDT · ~$${baseUsdValue.toFixed(2)} ${base}.`,
  ]

  if (signal === 'BUY' && usdt < 5) {
    lines.push(`Tip: Low USDT on this wallet - add USDT on BSC before buying here.`)
  }
  if (signal === 'SELL' && baseUsdValue < 2) {
    lines.push(`Tip: Very little ${base} showing - not much to sell from this wallet.`)
  }

  lines.push(
    ``,
    `Swaps run from Token Trading on BNB Chain (PancakeSwap) using ${walletPlainTitle === 'Personal Wallet' ? 'Personal Wallet' : 'your connected wallet'}. Binance is price reference only.`,
  )

  if (scoutChain !== 'bsc') {
    lines.push(`Scout elsewhere: ${scoutVenue} / ${scoutChain.toUpperCase()} - exploration only; execution stays BSC.`)
  }

  lines.push(`Not financial advice.`)

  return lines.join('\n')
}

/**
 * Builds inbox + popup copy for a single Binance USDT pair (spot reference).
 * Inbox insert is deduped per user/symbol/10m bucket; popup fields are always returned.
 */
export async function runTokenTradingFocus(
  userId: string,
  binanceSymbol: string,
  options?: {
    chain?: 'bsc' | 'base' | 'arbitrum' | 'polygon'
    venue?: 'pancakeswap' | 'uniswap' | 'auto'
    wallet?: FocusWalletPayload
  },
): Promise<{
  popupTitle: string
  popupBody: string
  inboxInserted: boolean
  signal: 'BUY' | 'SELL' | 'HOLD'
  refPrice: number
  buyRef: number
  sellRef: number
}> {
  const sym = binanceSymbol.toUpperCase()
  if (!BINANCE_SYMBOL_RE.test(sym)) {
    throw new Error('Invalid symbol')
  }

  const closes = await fetchKlineCloses(sym, 40)
  const { signal, smaValue, rsiValue } =
    closes.length >= 18
      ? computeTrendRsiSignal(closes, {
          smaPeriod: 8,
          threshold: 0.0015,
          useRsiFilter: true,
          rsiBuyMax: 70,
          rsiSellMin: 28,
        })
      : { signal: 'HOLD' as const, smaValue: null, rsiValue: null }

  const refPrice = closes.length ? closes[closes.length - 1]! : 0
  if (!Number.isFinite(refPrice) || refPrice <= 0) {
    throw new Error('No price data for symbol')
  }

  const band = Math.max(refPrice * 0.0015, refPrice * 1e-6)
  const buyRef = refPrice - band
  const sellRef = refPrice + band

  const base = baseAsset(sym)
  const chain = options?.chain ?? 'bsc'
  const venue =
    options?.venue && options?.venue !== 'auto'
      ? options.venue
      : chain === 'bsc'
        ? 'pancakeswap'
        : 'uniswap'

  const incomingWallet = options?.wallet
  const walletMode = incomingWallet?.mode ?? 'personal'
  const snap = await resolveWalletSnapshot(userId, base, incomingWallet ?? { mode: walletMode })

  const rsiStr = rsiValue != null ? rsiValue.toFixed(1) : 'n/a'
  const smaStr = smaValue != null ? fmtPrice(smaValue) : 'n/a'

  const popupTitle = `${base}/USDT · ${signal}`
  const plainBlock = buildPlainEnglishBlock({
    signal,
    base,
    refPrice,
    buyRef,
    sellRef,
    usdt: snap.usdt,
    baseUsdValue: snap.baseUsd,
    scoutChain: chain,
    scoutVenue: venue,
    walletPlainTitle: snap.plainTitle,
  })

  const technicalBlock = [
    `DETAILS`,
    `${base}/USDT · ${signal} · 1m Binance · RSI ${rsiStr} · SMA ${smaStr}`,
    `Band ~ ${fmtPrice(buyRef)} / ${fmtPrice(sellRef)}`,
    snap.technicalLine,
    `You confirm every swap.`,
  ].join('\n')

  const popupBody = `${plainBlock}${BODY_PLAIN_TECH_SPLIT}${technicalBlock}`

  const bucket = Math.floor(Date.now() / (10 * 60 * 1000))
  const dedupeKey = `focus:${sym}:${bucket}:${snap.dedupeSuffix}`
  const exists = await recentDedupeExists(userId, dedupeKey, 10 * 60 * 1000)
  let inboxInserted = false
  if (!exists) {
    await createInboxMessage({
      userId,
      category: InboxCategory.TOKEN_TRADING_SIGNAL,
      title: `${base}/USDT — ${signal} @ ${fmtPrice(refPrice)}`,
      body: `${popupBody}\n\nQuick link: Token Trading → ${base}/USDT`,
      metadata: {
        binanceSymbol: sym,
        signal,
        refPrice,
        buyRef,
        sellRef,
        rsi: rsiValue,
        sma: smaValue,
        chain,
        venue,
        walletMode,
        walletLabel: snap.plainTitle,
      },
      dedupeKey,
    })
    inboxInserted = true
  }

  return { popupTitle, popupBody, inboxInserted, signal, refPrice, buyRef, sellRef }
}
