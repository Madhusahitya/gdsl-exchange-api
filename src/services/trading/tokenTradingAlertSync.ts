import { InboxCategory } from '@cryptoflow/db'
import { computeTrendRsiSignal } from '../../lib/dexSignalMath'
import {
  getDexAllocationSuggestions,
  getPersonalWalletSummary,
  isPersonalWalletEnabled,
  PERSONAL_WALLET_TOKENS,
} from '../wallet/personalWalletService'
import { createInboxMessage, pruneOldInboxMessages, recentDedupeExists } from '../inbox/inboxService'

const ADVISORY_FOOTER = `

—
Venue: this platform executes PancakeSwap V2 on BNB Smart Chain (typical path USDT → WBNB → token). Uniswap and other chains are not integrated here.
Data: reference prices come from Binance public spot APIs; your on-chain fills can differ materially (gas, slippage, pool depth, bridge-pegs).
Risk: past moves do not predict results. No profit is guaranteed. This is decision-support software, not financial advice.`

const SIGNAL_DEDUPE_MS = 5 * 60 * 60 * 1000
const ALLOC_DEDUPE_MS = 20 * 60 * 60 * 1000

function utcDayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}

function displaySymbol(symbol: string): string {
  if (symbol === 'BTCB') return 'BTC'
  return symbol
}

async function fetchBinanceKlineCloses(binanceSymbol: string, limit = 30): Promise<number[]> {
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

/**
 * Builds **realistic** inbox rows from public market data + the user's personal-wallet snapshot.
 * Rate-limit callers (e.g. max once per few minutes per user).
 */
export async function syncTokenTradingInboxMessages(userId: string): Promise<{
  created: number
  skipped: number
  requiresPersonalWallet: boolean
}> {
  if (!isPersonalWalletEnabled()) {
    return { created: 0, skipped: 0, requiresPersonalWallet: false }
  }

  const summary = await getPersonalWalletSummary(userId)
  if (!summary) {
    return { created: 0, skipped: 0, requiresPersonalWallet: true }
  }

  let created = 0
  let skipped = 0
  const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000))

  const allocation = await getDexAllocationSuggestions(userId, summary)
  if (allocation.enabled && allocation.items.length > 0) {
    const dedupeKey = `alloc:${utcDayKey()}`
    const exists = await recentDedupeExists(userId, dedupeKey, ALLOC_DEDUPE_MS)
    if (!exists) {
      const top = allocation.items.slice(0, 4)
      const lines = top.map(
        (i) =>
          `• ${displaySymbol(i.symbol)} (${i.binanceSymbol}): 24h ${i.change24hPct != null ? `${i.change24hPct >= 0 ? '+' : ''}${i.change24hPct.toFixed(2)}%` : 'n/a'}, wallet ~$${i.walletUsd.toFixed(2)} — ${i.rationale}`,
      )
      const body = `Balance-aware snapshot (USDT free ≈ ${allocation.usdtFree.toFixed(2)})\n\n${lines.join('\n')}\n\n${allocation.disclaimer}${ADVISORY_FOOTER}`
      await createInboxMessage({
        userId,
        category: InboxCategory.BALANCE_ALLOCATION,
        title: `Allocation ideas · ${utcDayKey()} UTC`,
        body,
        metadata: { usdtFree: allocation.usdtFree, symbols: top.map((t) => t.symbol) },
        dedupeKey,
      })
      created += 1
    } else {
      skipped += 1
    }
  }

  const stable = new Set(['USDT', 'USDC'])
  const tokens = PERSONAL_WALLET_TOKENS.filter((t) => t.binanceSymbol && !stable.has(t.symbol))

  for (const t of tokens) {
    const sym = t.binanceSymbol!
    const closes = await fetchBinanceKlineCloses(sym, 32)
    await new Promise((r) => setTimeout(r, 90))
    if (closes.length < 18) {
      skipped += 1
      continue
    }
    const { signal, smaValue, rsiValue } = computeTrendRsiSignal(closes, {
      smaPeriod: 8,
      threshold: 0.0015,
      useRsiFilter: true,
      rsiBuyMax: 70,
      rsiSellMin: 28,
    })
    const lastClose = closes[closes.length - 1]!
    const refPrice = lastClose
    const label = displaySymbol(t.symbol)
    const dedupeKey = `tts:${t.symbol}:${signal}:${hourBucket}`

    if (await recentDedupeExists(userId, dedupeKey, SIGNAL_DEDUPE_MS)) {
      skipped += 1
      continue
    }

    const bal = summary.balances.find((b) => b.asset === t.symbol)
    const walletUsd = bal?.usdValue ?? 0
    const walletQty = bal?.amount ?? 0

    const smaStr = smaValue != null ? smaValue.toPrecision(6) : 'n/a'
    const rsiStr = rsiValue != null ? rsiValue.toFixed(1) : 'n/a'

    let title = `[${label}] Model: ${signal} · ref ~$${refPrice < 1 ? refPrice.toPrecision(6) : refPrice.toFixed(2)}`
    let detail = ''
    if (signal === 'BUY') {
      detail = `Short-horizon trend+RSI view is BUY-biased vs an 8-sample SMA on 1m Binance closes (RSI ${rsiStr}, price vs SMA ${smaStr}). That describes momentum on the Binance reference pair, not a promise of on-chain fill price. With ~$${walletUsd.toFixed(2)} in ${label} and USDT available, size any swap small vs your risk budget and confirm Pancake liquidity.`
    } else if (signal === 'SELL') {
      detail = `Short-horizon trend+RSI view is SELL-biased (RSI ${rsiStr}). If you hold ~${walletQty.toPrecision(4)} ${label} (~$${walletUsd.toFixed(2)}), consider whether to reduce exposure on BSC — still subject to spread, gas, and tax logic you apply.`
    } else {
      detail = `Short-horizon model is HOLD (no clear SMA distance trigger after RSI filter). Reference ~$${refPrice < 1 ? refPrice.toPrecision(6) : refPrice.toFixed(2)}; wallet ~$${walletUsd.toFixed(2)} in ${label}. Often the best action is no trade until volatility offers an edge you accept.`
    }

    const body = `${detail}${ADVISORY_FOOTER}`

    await createInboxMessage({
      userId,
      category: InboxCategory.TOKEN_TRADING_SIGNAL,
      title,
      body,
      metadata: {
        symbol: t.symbol,
        binanceSymbol: sym,
        signal,
        refPrice,
        rsi: rsiValue,
        sma: smaValue,
        walletUsd,
      },
      dedupeKey,
    })
    created += 1
  }

  await pruneOldInboxMessages(userId, 800)
  return { created, skipped, requiresPersonalWallet: false }
}
