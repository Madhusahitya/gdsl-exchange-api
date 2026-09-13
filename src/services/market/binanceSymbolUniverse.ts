/**
 * The set of Binance USDT spot pairs the candle store tracks.
 *
 * A pinned core is always present so the bot never loses its primary markets
 * when volume rankings shift. The remainder is the current top of the 24h
 * volume board, so a newly hot pair becomes a tradable candidate without a
 * redeploy — which is the whole point of letting the council pick coins.
 */
import { getBinanceUsdtMarketBoard } from '../trading/binanceMarketBoard'
import { logger } from '../../lib/logger'

/** Always tracked, in priority order. */
export const CORE_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'USDCUSDT',
]

/**
 * Stable-to-stable pairs top the volume board but carry no directional signal,
 * so they never earn a dynamic slot (USDCUSDT stays only because it is core).
 */
const STABLE_BASES = new Set([
  'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USD1',
  'EURI', 'AEUR', 'EUR', 'GBP', 'TRY', 'BRL', 'ARS', 'JPY',
])

const REFRESH_MS = 60 * 60 * 1000

function configuredSize(): number {
  const raw = Number(process.env.KLINE_UNIVERSE_SIZE)
  if (!Number.isFinite(raw)) return 50
  return Math.min(150, Math.max(CORE_SYMBOLS.length, Math.floor(raw)))
}

function baseAsset(symbol: string): string {
  return symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol
}

let universe: string[] = [...CORE_SYMBOLS]
let lastRefreshAt = 0
let inflight: Promise<string[]> | null = null

async function refresh(): Promise<string[]> {
  const size = configuredSize()
  const { rows } = await getBinanceUsdtMarketBoard(Math.max(200, size * 4))

  const next = [...CORE_SYMBOLS]
  const seen = new Set(next)
  for (const row of rows) {
    if (next.length >= size) break
    if (seen.has(row.symbol)) continue
    if (STABLE_BASES.has(baseAsset(row.symbol))) continue
    if (row.quoteVolume < 1_000_000) continue
    next.push(row.symbol)
    seen.add(row.symbol)
  }

  const added = next.filter((s) => !universe.includes(s))
  const dropped = universe.filter((s) => !next.includes(s))
  universe = next
  lastRefreshAt = Date.now()

  if (added.length > 0 || dropped.length > 0) {
    logger.info(
      { size: universe.length, added, dropped },
      '[kline] tracked symbol universe updated',
    )
  }
  return universe
}

/**
 * Current tracked universe. Refreshes from the volume board at most hourly and
 * falls back to the last known list (or the pinned core) if Binance is down.
 */
export async function getTrackedSymbols(force = false): Promise<string[]> {
  if (!force && Date.now() - lastRefreshAt < REFRESH_MS) return universe
  if (inflight) return inflight

  inflight = refresh()
    .catch((err) => {
      logger.warn({ err }, '[kline] universe refresh failed, keeping previous list')
      return universe
    })
    .finally(() => {
      inflight = null
    })

  return inflight
}

/** Last resolved universe without triggering network work. */
export function getTrackedSymbolsSync(): string[] {
  return universe
}

export function isCoreSymbol(symbol: string): boolean {
  return CORE_SYMBOLS.includes(symbol)
}
