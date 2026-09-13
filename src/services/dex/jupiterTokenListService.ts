/**
 * Bulk token discovery via Jupiter Tokens API v2 (verified + lst + stocks tags).
 *
 * The full verified universe is included — not just Binance-listed pairs — so
 * hundreds/thousands of Solana tokens are tradable. Price, liquidity, 24h change
 * and volume come from the v2 rows themselves (no extra Price v3 fan-out).
 * A Binance USDT match, when it exists, is preserved so the Binance-shaped chart
 * still works for the majors; everything else uses Jupiter-native data.
 */
import { catalogSolTokenForBinanceSymbol, SOL_DEX_CATALOG } from '../../lib/solDexCatalog'
import { logger } from '../../lib/logger'
import { getBinanceUsdtMarketBoard } from '../trading/binanceMarketBoard'
import { isJupiterConfigured } from './jupiterClassicService'
import { fetchJupiterTag, isJupiterTokenSafe, type JupiterV2Token } from './jupiterTokensV2'
import type { ResolvedSolToken } from './solTokenResolver'

function normalizeBaseSymbol(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Stablecoins quoted in USDC — not buy targets on DEX Jupiter. */
const SKIP_TRADE_BASES = new Set(['USDC', 'USDT', 'FDUSD', 'TUSD', 'DAI', 'BUSD', 'USDP', 'USDS', 'PYUSD'])

/** Cap the registry so the long tail stays sane in memory/UX (sorted by liquidity). */
const MAX_TRADABLE_TOKENS = 1500
/** Minimum on-chain liquidity to be listed at all. */
const MIN_LIQUIDITY_USD = 15_000

function volume24h(t: JupiterV2Token): number {
  const s = t.stats24h
  if (!s) return 0
  return (s.buyVolume ?? 0) + (s.sellVolume ?? 0)
}

/** Build tradable list: full Jupiter verified/lst/stocks universe, enriched + safety-filtered. */
export async function discoverJupiterTradableTokens(): Promise<ResolvedSolToken[]> {
  if (!isJupiterConfigured()) {
    return SOL_DEX_CATALOG.map((t) => ({ ...t, source: 'catalog' as const }))
  }

  const [verified, lst, stocks, binanceBoard] = await Promise.all([
    fetchJupiterTag('verified'),
    fetchJupiterTag('lst'),
    fetchJupiterTag('stocks'),
    getBinanceUsdtMarketBoard(2000).catch(() => ({ rows: [] as { symbol: string }[] })),
  ])

  const binanceByBase = new Map<string, string>()
  for (const row of binanceBoard.rows) {
    const base = row.symbol.replace(/USDT$/i, '').toUpperCase()
    binanceByBase.set(base, row.symbol.toUpperCase())
  }

  const bySymbol = new Map<string, ResolvedSolToken>()

  // Static catalog first — these are hand-verified majors with known mints.
  for (const t of SOL_DEX_CATALOG) {
    if (SKIP_TRADE_BASES.has(t.baseSymbol)) continue
    const hasBinance = binanceByBase.has(t.baseSymbol)
    bySymbol.set(t.baseSymbol, { ...t, source: 'catalog', hasBinance, native: !hasBinance })
  }

  const mergeRow = (row: JupiterV2Token) => {
    const base = normalizeBaseSymbol(row.symbol ?? '')
    if (!base || base.length < 2 || base.length > 12) return
    if (SKIP_TRADE_BASES.has(base)) return
    if (!isJupiterTokenSafe(row, MIN_LIQUIDITY_USD)) return

    const binanceSymbol = binanceByBase.get(base) ?? `${base}USDT`
    const hasBinance = binanceByBase.has(base)

    // Prefer the hand-verified catalog entry when one exists (keeps known mints).
    const catalog = catalogSolTokenForBinanceSymbol(binanceSymbol)
    if (catalog) {
      const prev = bySymbol.get(base)
      bySymbol.set(base, {
        ...catalog,
        source: 'catalog',
        hasBinance,
        native: !hasBinance,
        usdPrice: row.usdPrice,
        liquidityUsd: row.liquidity,
        volume24hUsd: volume24h(row),
        priceChange24h: row.stats24h?.priceChange ?? prev?.priceChange24h,
        icon: row.icon,
        organicScore: row.organicScore,
      })
      return
    }

    const existing = bySymbol.get(base)
    // Dedup by base — keep the deeper-liquidity mint if the symbol repeats.
    if (existing && (existing.liquidityUsd ?? 0) >= (row.liquidity ?? 0)) return

    bySymbol.set(base, {
      baseSymbol: base,
      binanceSymbol,
      mint: row.id!,
      decimals: row.decimals!,
      name: row.name ?? base,
      source: 'search',
      hasBinance,
      // Solana-native (no Binance pair): candle service should go straight to
      // on-chain OHLCV instead of timing out on a nonexistent Binance symbol.
      native: !hasBinance,
      usdPrice: row.usdPrice,
      liquidityUsd: row.liquidity,
      volume24hUsd: volume24h(row),
      priceChange24h: row.stats24h?.priceChange,
      icon: row.icon,
      organicScore: row.organicScore,
    })
  }

  for (const row of verified) mergeRow(row)
  for (const row of lst) mergeRow(row)
  for (const row of stocks) mergeRow(row)

  const all = [...bySymbol.values()]
  all.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
  const capped = all.slice(0, MAX_TRADABLE_TOKENS)

  logger.info(
    {
      verified: verified.length,
      lst: lst.length,
      stocks: stocks.length,
      kept: capped.length,
      binancePairs: binanceByBase.size,
    },
    '[jupiterTokenList] discovery complete',
  )
  return capped
}
