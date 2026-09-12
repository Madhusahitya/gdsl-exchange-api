/**
 * personalWalletService — server-managed BSC EVM wallet, one per user.
 *
 * The user funds this address once (any external wallet works) and the
 * platform signs all subsequent trades / withdrawals on their behalf. This
 * removes the constant MetaMask signature prompts that interrupt automated
 * trading.
 *
 * Security model:
 *   - Private keys are AES-256-GCM encrypted with WALLET_ENCRYPTION_KEY and
 *     never leave the API process unencrypted in memory longer than a single
 *     transaction signing operation.
 *   - The address itself is public (it's an on-chain identifier).
 *   - Withdrawals are rate-limited via the request validator; this service
 *     additionally validates destination format and amount.
 */

import {
  Contract,
  formatEther,
  formatUnits,
  FallbackProvider,
  JsonRpcProvider,
  parseEther,
  parseUnits,
  Wallet,
  type TransactionReceipt,
  type TransactionResponse,
  type Provider,
} from 'ethers'
import { getBscProvider } from '../../lib/bscProvider'
import { prisma, PersonalWalletWithdrawalStatus, TradeStatus } from '@cryptoflow/db'
import { erc20Abi } from '@cryptoflow/dex-pancake'
import { parseEvmWithdrawAddress } from '../../lib/evmAddress'

/** Withdraw-only ABI: package `main` points at `dist/`; a stale build omitted `transfer` and broke withdraw. */
const ERC20_TRANSFER_ABI = ['function transfer(address to, uint256 amount) returns (bool)'] as const
import { env } from '../../lib/env'
import { CONVERT_FEE_USD, feeTreasuryBsc } from '../../lib/feeTreasury'
import { decryptSecret, encryptSecret, isWalletCryptoConfigured } from '../../lib/walletCrypto'
import { logger } from '../../lib/logger'
import { roundTripRealizedPnl } from '../../lib/roundTripPnl'
import { withTimeout } from '../../lib/withTimeout'

const BSC_CHAIN_ID = 56

/** Token catalog mirrors the BSC tokens supported by the DEX UI. */
type BscTokenSpec = {
  symbol: string
  address: `0x${string}` | null
  decimals: number
  /** Binance ticker used for USD valuation. */
  binanceSymbol: string | null
}

/** BSC mainnet — Binance-Peg / blue-chip tokens with Pancake V2 liquidity (verify before prod). */
export const PERSONAL_WALLET_TOKENS: BscTokenSpec[] = [
  { symbol: 'BNB', address: null, decimals: 18, binanceSymbol: 'BNBUSDT' },
  { symbol: 'USDT', address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18, binanceSymbol: null },
  { symbol: 'USDC', address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18, binanceSymbol: 'USDCUSDT' },
  { symbol: 'BTCB', address: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', decimals: 18, binanceSymbol: 'BTCUSDT' },
  { symbol: 'ETH', address: '0x2170ed0880ac9a755fd29b2688956bd959f933f8', decimals: 18, binanceSymbol: 'ETHUSDT' },
  { symbol: 'XRP', address: '0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe', decimals: 18, binanceSymbol: 'XRPUSDT' },
  { symbol: 'DOGE', address: '0xba2ae424d960c26247dd6c32edc70b295c744c43', decimals: 8, binanceSymbol: 'DOGEUSDT' },
  { symbol: 'SOL', address: '0x570a5d26f7765ecb712c0924e4de545b89fd43df', decimals: 18, binanceSymbol: 'SOLUSDT' },
  { symbol: 'LINK', address: '0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd', decimals: 18, binanceSymbol: 'LINKUSDT' },
  { symbol: 'ADA', address: '0x3ee2200efb3400fabb9aacf31297cbdd1d435d47', decimals: 18, binanceSymbol: 'ADAUSDT' },
  { symbol: 'DOT', address: '0x7083609fce4d1d8dc0c979aab8c869ea2c873402', decimals: 18, binanceSymbol: 'DOTUSDT' },
  { symbol: 'AVAX', address: '0x1ce0c2827e2ef14d5c4f29a091d735a204794041', decimals: 18, binanceSymbol: 'AVAXUSDT' },
  { symbol: 'MATIC', address: '0xcc42724c6683b7e57334c4e856f4c9965ed682bd', decimals: 18, binanceSymbol: 'MATICUSDT' },
  { symbol: 'NEAR', address: '0x1fa4a73a3f0133f0025378af00236f3abdee5d63', decimals: 18, binanceSymbol: 'NEARUSDT' },
  { symbol: 'LTC', address: '0x4338665cbb7b2485a8855a139b75d5e34ab0db94', decimals: 18, binanceSymbol: 'LTCUSDT' },
]

const WBNB_ADDR = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' as const

/**
 * Personal-wallet swaps fire 8–15 RPC calls in <1s; on QuickNode free tier
 * (15 req/sec) one or two concurrent users hit `-32007  rate limit reached`
 * and the swap aborts. `getBscProvider()` returns an ethers FallbackProvider
 * across the configured primary RPC + public BSC RPCs, so the next provider
 * picks up the call when the primary stalls or 429s.
 */
function getProvider(): FallbackProvider | JsonRpcProvider {
  return getBscProvider()
}

const priceCache = new Map<string, { price: number; ts: number }>()
const PRICE_TTL_MS = 5_000

async function fetchBinancePrice(symbol: string | null): Promise<number | null> {
  if (!symbol) return null
  // Stables track 1.0; skip the network round-trip.
  if (symbol === 'USDTUSDT') return 1
  const cached = priceCache.get(symbol)
  if (cached && Date.now() - cached.ts < PRICE_TTL_MS) return cached.price
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`)
    if (!r.ok) return null
    const data = (await r.json()) as { price?: string }
    const price = data.price ? parseFloat(data.price) : NaN
    if (!Number.isFinite(price) || price <= 0) return null
    priceCache.set(symbol, { price, ts: Date.now() })
    return price
  } catch {
    return null
  }
}

/** True when the platform is configured to manage personal wallets. */
export function isPersonalWalletEnabled(): boolean {
  return isWalletCryptoConfigured()
}

export type PersonalWalletAssetBalance = {
  asset: string
  /** ERC-20 contract address; null for native BNB. */
  address: string | null
  amount: number
  amountRaw: string
  usdPrice: number | null
  usdValue: number
  /** gas = pays network fees; wrapped = wrapped gas/trading form; token = regular asset */
  role?: 'gas' | 'wrapped' | 'token'
  displayLabel?: string
  depositHint?: string
}

export type PersonalWalletSummary = {
  address: string
  chainId: number
  enabled: boolean
  balances: PersonalWalletAssetBalance[]
  totalUsdValue: number
  /** Change in total USD vs UTC-day anchor (first sync of the calendar day). */
  todayChangeUsd: number
  dayAnchorUtcDate: string | null
  /** Total USD at the UTC-day anchor (denominator for “today %”). */
  dayAnchorTotalUsd: number
  lastSyncedAt: string | null
  createdAt: string
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function generatePrivateKeyHex(): string {
  const wallet = Wallet.createRandom()
  return wallet.privateKey
}

/** Returns the user's wallet, creating one on first call. */
export async function ensurePersonalWallet(userId: string): Promise<{ address: string; created: boolean }> {
  if (!isPersonalWalletEnabled()) {
    throw new Error('Personal wallet is not configured (WALLET_ENCRYPTION_KEY missing).')
  }
  const existing = await prisma.personalWallet.findUnique({ where: { userId } })
  if (existing) return { address: existing.address, created: false }

  const privateKey = generatePrivateKeyHex()
  const signer = new Wallet(privateKey)
  const address = signer.address.toLowerCase() as `0x${string}`
  const encryptedPrivateKey = encryptSecret(privateKey)

  await prisma.personalWallet.create({
    data: {
      userId,
      address,
      encryptedPrivateKey,
      chainId: BSC_CHAIN_ID,
    },
  })
  logger.info(`[personal-wallet] created wallet for user ${userId} at ${address}`)
  return { address, created: true }
}

/** Returns the unencrypted wallet (used for signing). Caller must not log it. */
async function loadSigner(userId: string): Promise<Wallet> {
  const row = await prisma.personalWallet.findUnique({ where: { userId } })
  if (!row) throw new Error('Personal wallet not found for user')
  if (!row.enabled) throw new Error('Personal wallet is disabled')
  const pk = decryptSecret(row.encryptedPrivateKey)
  return new Wallet(pk, getProvider())
}

/** Cap wallet valuation RPC work so /dashboard/summary never hangs 30s+ on QuickNode. */
const PERSONAL_WALLET_SUMMARY_TIMEOUT_MS = 12_000
const WALLET_SUMMARY_MEM_TTL_MS = 30_000
const WALLET_LIVE_REFRESH_STALE_MS = 90_000

const walletSummaryMemCache = new Map<string, { at: number; summary: PersonalWalletSummary }>()
const walletSummaryInflight = new Map<string, Promise<PersonalWalletSummary | null>>()

function buildPersonalWalletSummaryFromDbRow(
  row: {
    address: string
    chainId: number
    enabled: boolean
    lastUsdValue: { toString(): string } | number
    dayAnchorUtcDate: Date | null
    dayAnchorTotalUsd: { toString(): string } | number | null
    lastSyncedAt: Date | null
    createdAt: Date
  },
): PersonalWalletSummary {
  const totalUsd = Number(row.lastUsdValue)
  const todayStart = startOfUtcDay(new Date())
  const anchorDate = row.dayAnchorUtcDate
  const anchorDay = anchorDate ? startOfUtcDay(new Date(anchorDate)) : null
  const resetDayAnchor = !anchorDay || anchorDay.getTime() < todayStart.getTime()
  const persistedAnchorUsd = row.dayAnchorTotalUsd != null ? Number(row.dayAnchorTotalUsd) : null
  const anchorBaselineUsd = resetDayAnchor ? totalUsd : (persistedAnchorUsd ?? totalUsd)
  const todayChangeUsd = totalUsd - anchorBaselineUsd
  const dayAnchorTotalUsdOut = resetDayAnchor ? totalUsd : (persistedAnchorUsd ?? totalUsd)

  return {
    address: row.address,
    chainId: row.chainId,
    enabled: row.enabled,
    balances: [],
    totalUsdValue: totalUsd,
    todayChangeUsd,
    dayAnchorTotalUsd: dayAnchorTotalUsdOut,
    dayAnchorUtcDate: (resetDayAnchor ? todayStart : (anchorDate ?? todayStart)).toISOString().slice(0, 10),
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

function rememberWalletSummary(userId: string, summary: PersonalWalletSummary): void {
  walletSummaryMemCache.set(userId, { at: Date.now(), summary })
}

/** Fire-and-forget live refresh (wallet page / background); never blocks dashboard. */
function schedulePersonalWalletLiveRefresh(userId: string): void {
  if (walletSummaryInflight.has(userId)) return
  const job = getPersonalWalletSummary(userId)
    .catch(() => null)
    .finally(() => {
      walletSummaryInflight.delete(userId)
    })
  walletSummaryInflight.set(userId, job)
}

/**
 * Fast path for /dashboard/summary — uses DB + in-memory cache only (no BSC RPC).
 * Live chain balances refresh in the background when stale.
 */
export async function getPersonalWalletSummaryForDashboard(
  userId: string,
): Promise<PersonalWalletSummary | null> {
  const mem = walletSummaryMemCache.get(userId)
  if (mem && Date.now() - mem.at < WALLET_SUMMARY_MEM_TTL_MS) {
    return mem.summary
  }

  const row = await prisma.personalWallet.findUnique({ where: { userId } })
  if (!row) return null

  const fast = buildPersonalWalletSummaryFromDbRow(row)
  rememberWalletSummary(userId, fast)

  const lastSyncedMs = row.lastSyncedAt?.getTime() ?? 0
  if (Date.now() - lastSyncedMs > WALLET_LIVE_REFRESH_STALE_MS) {
    schedulePersonalWalletLiveRefresh(userId)
  }
  return fast
}

/** Public summary (address + balances). Never returns the private key. */
export async function getPersonalWalletSummary(userId: string): Promise<PersonalWalletSummary | null> {
  try {
    const summary = await withTimeout(
      getPersonalWalletSummaryInner(userId),
      PERSONAL_WALLET_SUMMARY_TIMEOUT_MS,
      'personal_wallet_summary',
    )
    if (summary) rememberWalletSummary(userId, summary)
    return summary
  } catch (err) {
    logger.warn(
      { userId, err: err instanceof Error ? err.message : String(err) },
      '[personal-wallet] summary timed out or failed — dashboard will use ledger fallback',
    )
    const row = await prisma.personalWallet.findUnique({ where: { userId } })
    if (!row) return null
    const fallback = buildPersonalWalletSummaryFromDbRow(row)
    rememberWalletSummary(userId, fallback)
    return fallback
  }
}

async function readPersonalWalletTokenBalanceRaw(
  userId: string,
  token: BscTokenSpec,
): Promise<bigint> {
  const row = await prisma.personalWallet.findUnique({ where: { userId } })
  if (!row) return 0n
  const provider = getProvider()
  const address = row.address as `0x${string}`
  if (token.symbol === 'BNB') {
    const { sellable } = await readBnbBalancesRaw(provider, address)
    return sellable
  }
  if (token.address == null) {
    return provider.getBalance(address)
  }
  const c = new Contract(token.address, erc20Abi, provider)
  return c.balanceOf(address) as Promise<bigint>
}

/**
 * Wei amount safe to pass to Pancake on SELL — never above on-chain balance
 * (fixes "need 0.1818759127444392, have 0.181875912744439193" float round-up).
 */
export function sellAmountRawFromBalance(balanceRaw: bigint, cushionBps = 15): bigint {
  if (balanceRaw <= 0n) return 0n
  if (balanceRaw <= 1n) return balanceRaw
  return (balanceRaw * BigInt(10_000 - cushionBps)) / 10_000n
}

/** Pancake uses WBNB; book symbol is BNB — track WBNB for fills/PnL. */
function ledgerCounterAddress(token: BscTokenSpec): `0x${string}` | null {
  return token.address ?? (token.symbol === 'BNB' ? WBNB_ADDR : null)
}

async function readWbnbBalanceRaw(provider: Provider, address: string): Promise<bigint> {
  const c = new Contract(WBNB_ADDR, erc20Abi, provider)
  return c.balanceOf(address) as Promise<bigint>
}

async function readBnbBalancesRaw(
  provider: Provider,
  address: string,
): Promise<{ native: bigint; wbnb: bigint; sellable: bigint }> {
  const native = await provider.getBalance(address)
  const wbnb = await readWbnbBalanceRaw(provider, address)
  const wrapable = native > BNB_GAS_RESERVE_WEI ? native - BNB_GAS_RESERVE_WEI : 0n
  return { native, wbnb, sellable: wbnb + wrapable }
}

/** Wrap native BNB (above gas reserve) into WBNB so router sells the full position. */
async function ensureWbnbForSell(signer: Wallet, minWbnbNeeded: bigint): Promise<void> {
  const provider = signer.provider
  if (!provider) return
  const addr = signer.address
  let wbnb = await readWbnbBalanceRaw(provider, addr)
  if (wbnb >= minWbnbNeeded) return
  const { native } = await readBnbBalancesRaw(provider, addr)
  const wrapable = native > BNB_GAS_RESERVE_WEI ? native - BNB_GAS_RESERVE_WEI : 0n
  if (wrapable <= 0n) return
  const wbnbContract = new Contract(WBNB_ADDR, WBNB_DEPOSIT_ABI, signer)
  const tx = (await wbnbContract.deposit({ value: wrapable })) as TransactionResponse
  await tx.wait(1)
  wbnb = await readWbnbBalanceRaw(provider, addr)
  if (wbnb < minWbnbNeeded) {
    throw new Error('Insufficient BNB/WBNB balance to sell after wrap')
  }
}

/** On-chain token balance in wei — used for precise SELL sizing. */
export async function getPersonalWalletTokenBalanceRaw(
  userId: string,
  tokenSymbol: string,
): Promise<bigint> {
  const token = PERSONAL_WALLET_TOKENS.find((t) => t.symbol === tokenSymbol.toUpperCase())
  if (!token) return 0n
  try {
    return await readPersonalWalletTokenBalanceRaw(userId, token)
  } catch (err) {
    logger.warn(
      { userId, tokenSymbol, err: (err as Error).message },
      '[personal-wallet] token balance raw read failed',
    )
    return 0n
  }
}

/** Single-token on-chain balance — used by dexWatcher (never the cached summary). */
export async function getPersonalWalletTokenBalance(
  userId: string,
  tokenSymbol: string,
): Promise<number> {
  const token = PERSONAL_WALLET_TOKENS.find((t) => t.symbol === tokenSymbol.toUpperCase())
  if (!token) return 0
  try {
    const amountRaw = await readPersonalWalletTokenBalanceRaw(userId, token)
    const amountStr =
      token.address == null ? formatEther(amountRaw) : formatUnits(amountRaw, token.decimals)
    const amount = parseFloat(amountStr)
    return Number.isFinite(amount) && amount > 0 ? amount : 0
  } catch (err) {
    logger.warn(
      { userId, tokenSymbol, err: (err as Error).message },
      '[personal-wallet] token balance read failed',
    )
    return 0
  }
}

async function getPersonalWalletSummaryInner(userId: string): Promise<PersonalWalletSummary | null> {
  const row = await prisma.personalWallet.findUnique({ where: { userId } })
  if (!row) return null
  const provider = getProvider()
  const address = row.address as `0x${string}`

  const balances: PersonalWalletAssetBalance[] = []
  let totalUsd = 0

  // Parallel balance reads — sequential RPC was a major cause of dashboard
  // timeouts when QuickNode throttled (15 tokens × 200ms = blank UI).
  const balanceRows = (
    await Promise.all(
      PERSONAL_WALLET_TOKENS.map(async (token): Promise<PersonalWalletAssetBalance | PersonalWalletAssetBalance[] | null> => {
      let amountRaw: bigint = 0n
      try {
        if (token.symbol === 'BNB') {
          const { native, wbnb } = await readBnbBalancesRaw(provider, address)
          const nativeAmt = parseFloat(formatEther(native))
          const wbnbAmt = parseFloat(formatUnits(wbnb, 18))
          const usdPrice = await fetchBinancePrice(token.binanceSymbol)
          const rows: PersonalWalletAssetBalance[] = [
            {
              asset: 'BNB',
              address: null,
              amount: Number.isFinite(nativeAmt) ? nativeAmt : 0,
              amountRaw: native.toString(),
              usdPrice,
              usdValue: usdPrice != null && Number.isFinite(nativeAmt) ? nativeAmt * usdPrice : 0,
              role: 'gas',
              displayLabel: 'Gas fee token',
              depositHint: 'Deposit native BNB on BSC (BEP-20) to pay transaction fees. Gas is paid in BNB only — not WBNB.',
            },
            {
              asset: 'WBNB',
              address: WBNB_ADDR,
              amount: Number.isFinite(wbnbAmt) ? wbnbAmt : 0,
              amountRaw: wbnb.toString(),
              usdPrice,
              usdValue: usdPrice != null && Number.isFinite(wbnbAmt) ? wbnbAmt * usdPrice : 0,
              role: 'wrapped',
              displayLabel: 'Wrapped BNB (trading)',
              depositHint: 'Usually from DEX trades. Auto-unwrapped to native BNB when gas is needed.',
            },
          ]
          return rows
        }
        if (token.address == null) {
          amountRaw = await provider.getBalance(address)
        } else {
          const c = new Contract(token.address, erc20Abi, provider)
          amountRaw = await c.balanceOf(address)
        }
      } catch (err) {
        logger.warn(`[personal-wallet] balance read failed for ${token.symbol}: ${(err as Error).message}`)
        return null
      }
      const amountStr =
        token.address == null ? formatEther(amountRaw) : formatUnits(amountRaw, token.decimals)
      const amount = parseFloat(amountStr)
      if (!Number.isFinite(amount) || amount === 0) {
        if (['BNB', 'USDT', 'USDC'].includes(token.symbol)) {
          return {
            asset: token.symbol,
            address: token.address,
            amount: 0,
            amountRaw: '0',
            usdPrice: token.symbol === 'USDT' || token.symbol === 'USDC' ? 1 : null,
            usdValue: 0,
          } satisfies PersonalWalletAssetBalance
        }
        return null
      }
      const usdPrice = token.symbol === 'USDT' ? 1 : await fetchBinancePrice(token.binanceSymbol)
      const usdValue = usdPrice != null ? amount * usdPrice : 0
      return {
        asset: token.symbol,
        address: token.address,
        amount,
        amountRaw: amountRaw.toString(),
        usdPrice,
        usdValue,
        role: 'token',
      } satisfies PersonalWalletAssetBalance
    }),
  )
  ).flat()

  for (const b of balanceRows) {
    if (!b) continue
    totalUsd += b.usdValue
    balances.push(b)
  }

  const todayStart = startOfUtcDay(new Date())
  const anchorDate = row.dayAnchorUtcDate
  const anchorDay = anchorDate ? startOfUtcDay(new Date(anchorDate)) : null
  const resetDayAnchor = !anchorDay || anchorDay.getTime() < todayStart.getTime()

  const persistedAnchorUsd = row.dayAnchorTotalUsd != null ? Number(row.dayAnchorTotalUsd) : null
  const anchorBaselineUsd = resetDayAnchor ? totalUsd : (persistedAnchorUsd ?? totalUsd)
  const todayChangeUsd = totalUsd - anchorBaselineUsd
  const dayAnchorTotalUsdOut = resetDayAnchor ? totalUsd : (persistedAnchorUsd ?? totalUsd)

  try {
    await prisma.personalWallet.update({
      where: { userId },
      data: {
        lastUsdValue: totalUsd,
        lastSyncedAt: new Date(),
        ...(resetDayAnchor ? { dayAnchorUtcDate: todayStart, dayAnchorTotalUsd: totalUsd } : {}),
      },
    })
  } catch (err) {
    logger.warn({ userId, err }, '[personal-wallet] failed to persist lastUsdValue')
  }

  return {
    address: row.address,
    chainId: row.chainId,
    enabled: row.enabled,
    balances,
    totalUsdValue: totalUsd,
    todayChangeUsd,
    dayAnchorTotalUsd: dayAnchorTotalUsdOut,
    dayAnchorUtcDate: (resetDayAnchor ? todayStart : (anchorDate ?? todayStart)).toISOString().slice(0, 10),
    lastSyncedAt: new Date().toISOString(),
    createdAt: row.createdAt.toISOString(),
  }
}

const DEX_SUGGESTIONS_DISCLAIMER =
  'Educational ranking from public 24h price moves vs your wallet — not financial advice. DEX execution uses BSC + Pancake liquidity; always verify pool depth and contract addresses.'

export type DexSuggestionItem = {
  symbol: string
  binanceSymbol: string
  change24hPct: number | null
  lastPriceUsd: number | null
  walletUsd: number
  stance: 'stable' | 'momentum_up' | 'pullback' | 'risk_off'
  rationale: string
}

/**
 * @param cachedSummary When set (including `null`), skips an extra wallet fetch — use after `getPersonalWalletSummary`.
 */
export async function getDexAllocationSuggestions(
  userId: string,
  cachedSummary?: PersonalWalletSummary | null,
): Promise<{
  enabled: boolean
  usdtFree: number
  items: DexSuggestionItem[]
  disclaimer: string
}> {
  if (!isWalletCryptoConfigured()) {
    return { enabled: false, usdtFree: 0, items: [], disclaimer: DEX_SUGGESTIONS_DISCLAIMER }
  }
  const summary =
    cachedSummary !== undefined ? cachedSummary : await getPersonalWalletSummary(userId)
  if (!summary) {
    return { enabled: false, usdtFree: 0, items: [], disclaimer: DEX_SUGGESTIONS_DISCLAIMER }
  }
  const usdt = summary.balances.find((b) => b.asset === 'USDT')
  const usdtFree = usdt?.amount ?? 0
  const byAsset = new Map(summary.balances.map((b) => [b.asset, b]))

  const items: DexSuggestionItem[] = []
  for (const t of PERSONAL_WALLET_TOKENS) {
    if (!t.binanceSymbol || t.symbol === 'USDT') continue
    const bal = byAsset.get(t.symbol)
    const walletUsd = bal?.usdValue ?? 0
    let change24hPct: number | null = null
    let lastPriceUsd: number | null = null
    try {
      const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${t.binanceSymbol}`)
      if (r.ok) {
        const j = (await r.json()) as { priceChangePercent?: string; lastPrice?: string }
        change24hPct = j.priceChangePercent != null ? parseFloat(j.priceChangePercent) : null
        lastPriceUsd = j.lastPrice != null ? parseFloat(j.lastPrice) : null
      }
      await new Promise((r) => setTimeout(r, 60))
    } catch {
      /* skip */
    }
    const ch = change24hPct ?? 0
    let stance: DexSuggestionItem['stance'] = 'stable'
    let rationale = 'Flat 24h move vs USDT — no strong public momentum signal.'
    if (ch >= 4) {
      stance = 'momentum_up'
      rationale =
        'Strong positive 24h % on the Binance reference pair — often risk-on; size small and check Pancake liquidity before buying on BSC.'
    } else if (ch <= -4) {
      stance = 'pullback'
      rationale =
        'Negative 24h % on the reference pair — mean-reversion is possible but trends can extend; avoid catching knives without a plan.'
    } else if (ch <= -1.5) {
      stance = 'risk_off'
      rationale = 'Mild sell pressure on the reference pair — consider keeping more USDT dry powder if you are uncertain.'
    }
    if (walletUsd > 5 && ch < 0) {
      rationale += ` You already hold ~$${walletUsd.toFixed(0)} here — rebalancing or partial de-risk may be worth reviewing.`
    }
    if (usdtFree > 10 && ch > 2 && walletUsd < 3) {
      rationale += ` You have spare USDT (~$${usdtFree.toFixed(0)}) — if you accept volatility, this token is on the watchlist only after you confirm the BSC pool.`
    }
    items.push({
      symbol: t.symbol,
      binanceSymbol: t.binanceSymbol,
      change24hPct,
      lastPriceUsd,
      walletUsd,
      stance,
      rationale,
    })
  }
  items.sort((a, b) => Math.abs(b.change24hPct ?? 0) - Math.abs(a.change24hPct ?? 0))
  return {
    enabled: true,
    usdtFree,
    items: items.slice(0, 12),
    disclaimer: DEX_SUGGESTIONS_DISCLAIMER,
  }
}

export type WithdrawRequest = {
  asset: string
  amount: number
  toAddress: string
}

export async function withdrawFromPersonalWallet(
  userId: string,
  req: WithdrawRequest,
): Promise<{ id: string; txHash: string; status: PersonalWalletWithdrawalStatus }> {
  const toAddress = parseEvmWithdrawAddress(req.toAddress)
  if (!Number.isFinite(req.amount) || req.amount <= 0) {
    throw new Error('Amount must be positive')
  }
  const token = PERSONAL_WALLET_TOKENS.find((t) => t.symbol === req.asset.toUpperCase())
  if (!token) throw new Error(`Unsupported asset ${req.asset}`)

  const walletRow = await prisma.personalWallet.findUnique({ where: { userId } })
  if (!walletRow) throw new Error('Personal wallet not found')
  if (!walletRow.enabled) throw new Error('Personal wallet is disabled')

  const signer = await loadSigner(userId)

  // Pre-flight balance check so we fail fast (and never broadcast a doomed tx).
  const provider = getProvider()
  const onchainBalance =
    token.address == null
      ? await provider.getBalance(signer.address)
      : await (new Contract(token.address, erc20Abi, provider).balanceOf(signer.address) as Promise<bigint>)
  const requiredRaw =
    token.address == null
      ? parseEther(req.amount.toString())
      : parseUnits(req.amount.toString(), token.decimals)
  if (onchainBalance < requiredRaw) {
    throw new Error(`Insufficient ${token.symbol} balance — available ${
      token.address == null ? formatEther(onchainBalance) : formatUnits(onchainBalance, token.decimals)
    }, requested ${req.amount}`)
  }

  // Persist the request first so we can correlate failures.
  const record = await prisma.personalWalletWithdrawal.create({
    data: {
      walletId: walletRow.id,
      userId,
      toAddress: toAddress.toLowerCase(),
      asset: token.symbol,
      amount: req.amount,
      status: PersonalWalletWithdrawalStatus.PROCESSING,
    },
  })

  try {
    let response: TransactionResponse
    if (token.address == null) {
      response = await signer.sendTransaction({
        to: toAddress,
        value: requiredRaw,
      })
    } else {
      const erc20 = new Contract(token.address, ERC20_TRANSFER_ABI, signer)
      response = (await erc20.transfer(toAddress, requiredRaw)) as unknown as TransactionResponse
    }

    // Update with hash and wait for confirmation in the background.
    await prisma.personalWalletWithdrawal.update({
      where: { id: record.id },
      data: { txHash: response.hash },
    })

    void response
      .wait(1)
      .then(async (receipt: TransactionReceipt | null) => {
        const ok = receipt?.status === 1
        const feeUsd = await estimateFeeUsd(receipt)
        await prisma.personalWalletWithdrawal.update({
          where: { id: record.id },
          data: {
            status: ok ? PersonalWalletWithdrawalStatus.COMPLETED : PersonalWalletWithdrawalStatus.FAILED,
            processedAt: new Date(),
            feeUsd,
            errorMessage: ok ? null : 'Transaction reverted',
          },
        })
      })
      .catch(async (err) => {
        await prisma.personalWalletWithdrawal.update({
          where: { id: record.id },
          data: {
            status: PersonalWalletWithdrawalStatus.FAILED,
            processedAt: new Date(),
            errorMessage: (err as Error).message,
          },
        })
      })

    return { id: record.id, txHash: response.hash, status: PersonalWalletWithdrawalStatus.PROCESSING }
  } catch (err) {
    await prisma.personalWalletWithdrawal.update({
      where: { id: record.id },
      data: {
        status: PersonalWalletWithdrawalStatus.FAILED,
        processedAt: new Date(),
        errorMessage: (err as Error).message,
      },
    })
    throw err
  }
}

async function estimateFeeUsd(receipt: TransactionReceipt | null): Promise<number> {
  if (!receipt) return 0
  try {
    const gasUsed = receipt.gasUsed ?? 0n
    const effective = receipt.gasPrice ?? 0n
    const wei = gasUsed * effective
    const bnb = parseFloat(formatEther(wei))
    const bnbUsd = (await fetchBinancePrice('BNBUSDT')) ?? 0
    return bnb * bnbUsd
  } catch {
    return 0
  }
}

export async function listWithdrawals(userId: string, limit = 20) {
  return prisma.personalWalletWithdrawal.findMany({
    where: { userId },
    orderBy: { requestedAt: 'desc' },
    take: limit,
  })
}

/** Disable the wallet (admin or "lock my account" action). */
export async function setWalletEnabled(userId: string, enabled: boolean) {
  await prisma.personalWallet.update({
    where: { userId },
    data: { enabled },
  })
}

/** Used by the trading bot to obtain a signer attached to the BSC provider. */
export async function getPersonalSigner(userId: string): Promise<Wallet> {
  return loadSigner(userId)
}

/**
 * Execute a PancakeSwap V2 swap from the user's personal wallet.
 * The platform signs and broadcasts; the user provides intent only (asset + amount + side).
 * BUY = USDT → token, SELL = token → USDT.
 */
const PANCAKE_V2_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E' as const
const USDT_ADDR = '0x55d398326f99059fF775485246999027B3197955' as const
/** Keep native BNB for gas when wrapping the rest into WBNB for Pancake sells. */
const BNB_GAS_RESERVE_WEI = parseEther('0.00025')

const WBNB_DEPOSIT_ABI = ['function deposit() payable', 'function balanceOf(address) view returns (uint256)'] as const
const WBNB_WITHDRAW_ABI = ['function withdraw(uint wad)'] as const

/** Minimum native BNB to sign BSC ERC-20 transfers (gas). */
export const BSC_MIN_NATIVE_GAS_WEI = parseEther('0.0008')

/**
 * Gas on BSC is paid in native BNB only. WBNB is shown separately in the wallet UI
 * and auto-unwrapped when gas is needed.
 */
export async function ensureNativeBnbForGas(
  signer: Wallet,
  minNative: bigint = BSC_MIN_NATIVE_GAS_WEI,
  walletLabel = 'Your BSC wallet',
): Promise<void> {
  const provider = signer.provider ?? getProvider()
  const addr = signer.address
  let native = await provider.getBalance(addr)
  if (native >= minNative) return

  const wbnbBal = await readWbnbBalanceRaw(provider, addr)
  if (native + wbnbBal < minNative) {
    throw new Error(
      `${walletLabel} needs BNB for gas — have ${formatEther(native)} native + ${formatUnits(wbnbBal, 18)} WBNB (${formatUnits(native + wbnbBal, 18)} total). Deposit ~0.002 native BNB and try again.`,
    )
  }

  const unwrapTarget = minNative + parseEther('0.00012')
  const deficit = unwrapTarget > native ? unwrapTarget - native : 0n
  if (deficit <= 0n) return

  const unwrapAmount = deficit > wbnbBal ? wbnbBal : deficit
  const wbnb = new Contract(WBNB_ADDR, [...WBNB_DEPOSIT_ABI, ...WBNB_WITHDRAW_ABI], signer)
  const tx = (await wbnb.withdraw(unwrapAmount)) as TransactionResponse
  await tx.wait(1)

  native = await provider.getBalance(addr)
  if (native < minNative) {
    throw new Error('Could not unwrap enough WBNB for gas — deposit a little native BNB and try again.')
  }
}

const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
] as const

/**
 * Build every candidate swap path we're willing to try at execution time.
 *
 * Why this matters (the actual "slippage" bug investors saw):
 *   PancakeSwap V2 charges 0.25% per hop. Routing a USDT↔BTCB swap through
 *   WBNB therefore burns 0.5% in LP fees + the price impact of TWO pools,
 *   even though Pancake V2 has a direct USDT–BTCB pool with ~$40M+ TVL.
 *   On a $5 trade the difference is ~$0.025 — looks tiny, but compounds
 *   into the "trade closed at $0.00" pattern users were complaining about
 *   because gas (~$0.10) + 2× LP fees + 2× spread = 5–8% round-trip
 *   friction. Dropping one hop wherever a direct pool exists cuts that
 *   friction roughly in half.
 *
 * We don't hardcode "which tokens have direct pools" — that would rot.
 * Instead we return both candidates and let `quoteBestPath` ask the
 * router which one returns more output; a missing/empty direct pool
 * simply reverts on getAmountsOut and gets skipped.
 *
 * BNB is the one degenerate case: USDT-BNB IS the WBNB route, so we
 * return just the single hop.
 */
function candidateSwapPaths(
  token: BscTokenSpec,
  side: 'BUY' | 'SELL',
): `0x${string}`[][] {
  if (token.symbol === 'BNB') {
    return [side === 'BUY' ? [USDT_ADDR, WBNB_ADDR] : [WBNB_ADDR, USDT_ADDR]]
  }
  const tokenAddr = token.address as `0x${string}`
  if (side === 'BUY') {
    return [
      [USDT_ADDR, tokenAddr], // direct (better fees + spread when pool exists)
      [USDT_ADDR, WBNB_ADDR, tokenAddr], // legacy two-hop fallback
    ]
  }
  return [
    [tokenAddr, USDT_ADDR],
    [tokenAddr, WBNB_ADDR, USDT_ADDR],
  ]
}

type QuotedPath = {
  path: `0x${string}`[]
  expectedOut: bigint
  /** Two-element shape: ["direct"] vs ["wbnb"] for log lines / metrics. */
  label: 'direct' | 'wbnb' | 'single'
}

/**
 * Quote every candidate path and return the one that returns the most
 * output. Paths that revert (e.g. no direct pool, zero liquidity, blocked
 * pair) are silently skipped. Throws only when ALL candidates revert,
 * which indicates a real configuration problem (wrong token address,
 * Pancake out of service, etc.) rather than just a missing route.
 */
async function quoteBestPath(
  router: Contract,
  amountIn: bigint,
  candidates: `0x${string}`[][],
): Promise<QuotedPath> {
  const quotes: QuotedPath[] = []
  for (const [idx, path] of candidates.entries()) {
    try {
      const amountsOut = (await router.getAmountsOut(amountIn, path)) as bigint[]
      const expectedOut = amountsOut[amountsOut.length - 1] ?? 0n
      if (expectedOut <= 0n) continue
      const label: QuotedPath['label'] =
        path.length === 2 ? (idx === 0 ? 'direct' : 'single') : 'wbnb'
      quotes.push({ path, expectedOut, label })
    } catch {
      // Pool absent or out of liquidity — skip and try the next candidate.
      // We don't surface this as an error because it's expected behaviour
      // (the whole point of having multiple candidates is graceful fallback).
    }
  }
  if (quotes.length === 0) {
    throw new Error('No Pancake V2 route found for this token. The pool may be paused or out of liquidity.')
  }
  // Sort descending by expectedOut: most tokens out (BUY) or most USDT out (SELL) wins.
  quotes.sort((a, b) => (b.expectedOut > a.expectedOut ? 1 : b.expectedOut < a.expectedOut ? -1 : 0))
  return quotes[0]
}

/** Read-only Pancake quote for auto-exit — uses same routes as executePersonalSwap. */
export async function quoteTokenToUsdt(
  token: BscTokenSpec,
  amountInRaw: bigint,
): Promise<{ usdtOutRaw: bigint; exitPriceUsd: number } | null> {
  if (amountInRaw <= 0n) return null
  try {
    const provider = getProvider()
    const router = new Contract(PANCAKE_V2_ROUTER, ROUTER_ABI, provider)
    const candidates = candidateSwapPaths(token, 'SELL')
    const best = await quoteBestPath(router, amountInRaw, candidates)
    const sold = Number(formatUnits(amountInRaw, token.decimals))
    const usdt = Number(formatUnits(best.expectedOut, 18))
    if (!Number.isFinite(sold) || sold <= 0 || !Number.isFinite(usdt) || usdt <= 0) return null
    return { usdtOutRaw: best.expectedOut, exitPriceUsd: usdt / sold }
  } catch {
    return null
  }
}

export type PersonalSwapRequest = {
  side: 'BUY' | 'SELL'
  tokenSymbol: string
  /** USDT amount when BUY; token amount when SELL. */
  amount: number
  /** Slippage tolerance in basis points (default 100 = 1%). */
  slippageBps?: number
  /** When set, closes this OPEN row (server auto-exit) instead of oldest FIFO only. */
  closeTradeId?: string
  /** SELL only: exact wei from chain (skips float parseUnits round-up). */
  sellAmountRaw?: bigint
}

export type PersonalSwapResult = {
  txHash: string
  side: 'BUY' | 'SELL'
  tokenSymbol: string
  amountIn: string
  expectedOut: string
  minOut: string
  /** Canonical dashboard trade row written for this swap. */
  trade: {
    id: string
    pair: string
    allocationUsd: number
    entryPrice: number
    pnl: number | null
    /**
     * Sell-side fill price when this swap closed an open position. Null on
     * fresh BUYs (no exit yet) and on orphan SELLs (nothing to close).
     */
    exitPrice: number | null
    /**
     * Position lifecycle role of this swap:
     *   BUY    — opened a new long position (status === 'OPEN')
     *   CLOSED — completed a round-trip; pnl is the realized USDT delta
     *   SELL   — orphan sell with no matching open position
     */
    side: 'BUY' | 'SELL' | 'CLOSED'
    /** Mirrors Prisma's Trade.status — 'OPEN' (still holding) or 'CLOSED'. */
    status: 'OPEN' | 'CLOSED'
  }
}

/**
 * Manual dashboard exit: sell on-chain balance for a symbol and close OPEN book rows.
 * One Pancake swap; oldest OPEN gets realized PnL; sibling OPEN rows cancel if wallet is empty.
 */
export async function sellAggregatedOpenPosition(
  userId: string,
  symbol: string,
): Promise<PersonalSwapResult> {
  const sym = symbol.toUpperCase()
  const token = PERSONAL_WALLET_TOKENS.find((t) => t.symbol === sym)
  if (!token) throw new Error(`Unsupported symbol ${sym}`)
  if (!token.address && sym !== 'BNB') {
    throw new Error(`Unsupported or non-sellable symbol ${sym}`)
  }

  const pair = `${sym}/USDT`
  const strategyId = await ensurePersonalWalletStrategyId()
  const openTrades = await prisma.trade.findMany({
    where: { userId, pair, strategyId, status: TradeStatus.OPEN },
    orderBy: { createdAt: 'asc' },
  })
  if (openTrades.length === 0) throw new Error(`No open ${sym} position in the trade book`)

  const signer = await loadSigner(userId)
  if (sym === 'BNB') {
    const provider = getProvider()
    const { sellable } = await readBnbBalancesRaw(provider, signer.address)
    if (sellable <= 0n) throw new Error(`No ${sym} balance in the personal wallet`)
    const target = sellAmountRawFromBalance(sellable)
    await ensureWbnbForSell(signer, target)
  }

  const balanceRaw =
    sym === 'BNB'
      ? await readWbnbBalanceRaw(getProvider(), signer.address)
      : await readPersonalWalletTokenBalanceRaw(userId, token)
  if (balanceRaw <= 0n) throw new Error(`No ${sym} balance in the personal wallet`)

  const lotQty = openTrades.reduce((sum, t) => {
    const entry = Number(t.entryPrice)
    const alloc = Number(t.allocationUsd ?? 0)
    return entry > 0 && alloc > 0 ? sum + alloc / entry : sum
  }, 0)
  const decimals = token.address == null ? 18 : token.decimals

  let sellRaw = sellAmountRawFromBalance(balanceRaw)
  if (lotQty > 1e-12) {
    const lotRaw = parseUnits(lotQty.toFixed(Math.min(12, decimals)), decimals)
    const lotCap = (lotRaw * 102n) / 100n
    if (sellRaw > lotCap) sellRaw = sellAmountRawFromBalance(lotCap)
  }

  const sellQty = Number(formatUnits(sellRaw, decimals))
  if (!Number.isFinite(sellQty) || sellQty <= 0) {
    throw new Error(`No ${sym} balance available to sell after rounding`)
  }

  const result = await executePersonalSwap(userId, {
    side: 'SELL',
    tokenSymbol: sym,
    amount: sellQty,
    slippageBps: 100,
    closeTradeId: openTrades[0]!.id,
    sellAmountRaw: sellRaw,
  })

  for (const t of openTrades.slice(1)) {
    await prisma.trade.update({
      where: { id: t.id },
      data: { status: TradeStatus.CANCELLED },
    })
  }

  return result
}

async function ensurePersonalWalletStrategyId(): Promise<string> {
  const strategy = await prisma.strategy.upsert({
    where: { name: 'DEX Personal Wallet' },
    update: {},
    create: {
      name: 'DEX Personal Wallet',
      description: 'Manual and assistant-triggered swaps executed by the server-signed personal wallet.',
      riskLevel: 'MEDIUM',
    },
    select: { id: true },
  })
  return strategy.id
}

export async function executePersonalSwap(
  userId: string,
  req: PersonalSwapRequest,
): Promise<PersonalSwapResult> {
  if (!req.tokenSymbol || typeof req.tokenSymbol !== 'string') throw new Error('tokenSymbol required')
  if (!Number.isFinite(req.amount) || req.amount <= 0) throw new Error('amount must be positive')

  const token = PERSONAL_WALLET_TOKENS.find((t) => t.symbol === req.tokenSymbol.toUpperCase())
  if (!token) throw new Error(`Unsupported token ${req.tokenSymbol}`)
  if (token.symbol === 'USDT') throw new Error('Cannot swap USDT against itself')

  const slippageBpsRaw = req.slippageBps ?? 100
  const slippageBps = BigInt(Math.min(2000, Math.max(10, Math.floor(slippageBpsRaw))))

  const signer = await loadSigner(userId)
  const provider = getProvider()
  const router = new Contract(PANCAKE_V2_ROUTER, ROUTER_ABI, signer)

  const inDecimals = req.side === 'BUY' ? 18 /* USDT */ : token.decimals
  const inToken = req.side === 'BUY' ? USDT_ADDR : (token.address ?? WBNB_ADDR)

  if (req.side === 'SELL' && token.symbol === 'BNB') {
    const { sellable } = await readBnbBalancesRaw(provider, signer.address)
    const wrapTarget =
      req.sellAmountRaw != null && req.sellAmountRaw > 0n
        ? req.sellAmountRaw
        : sellAmountRawFromBalance(sellable)
    await ensureWbnbForSell(signer, wrapTarget)
  }

  let balance: bigint = await (new Contract(inToken, erc20Abi, provider).balanceOf(signer.address) as Promise<bigint>)

  let amountIn: bigint
  if (req.side === 'SELL' && req.sellAmountRaw != null && req.sellAmountRaw > 0n) {
    amountIn = req.sellAmountRaw > balance ? sellAmountRawFromBalance(balance) : req.sellAmountRaw
  } else if (req.side === 'SELL') {
    let desired = parseUnits(req.amount.toFixed(Math.min(12, inDecimals)), inDecimals)
    if (desired > balance) desired = balance
    amountIn = sellAmountRawFromBalance(desired > 0n ? desired : balance)
  } else {
    amountIn = parseUnits(req.amount.toString(), inDecimals)
  }

  if (req.side === 'BUY' && balance < amountIn) {
    throw new Error(
      `Insufficient USDT balance — have ${formatUnits(balance, inDecimals)}, need ${req.amount}`,
    )
  }

  if (req.side === 'SELL' && (amountIn <= 0n || amountIn > balance)) {
    throw new Error(
      `Insufficient ${token.symbol} balance — have ${formatUnits(balance, inDecimals)}, cannot sell`,
    )
  }

  // Ensure router has allowance.
  const erc20 = new Contract(inToken, erc20Abi, signer)
  const currentAllowance: bigint = (await erc20.allowance(signer.address, PANCAKE_V2_ROUTER)) as bigint
  if (currentAllowance < amountIn) {
    const approveTx = (await erc20.approve(PANCAKE_V2_ROUTER, BigInt(2) ** BigInt(256) - BigInt(1))) as TransactionResponse
    await approveTx.wait(1)
  }

  // Quote every candidate path (direct USDT↔token + the WBNB-routed fallback)
  // and pick the one that returns the most output. This is where we close
  // the "DEX fill far from market" gap users were seeing: for tokens with
  // deep direct USDT pools (BTCB, ETH, USDC, BUSD-class), the single-hop
  // path skips a full 0.25% LP fee AND the price impact of the WBNB pool.
  const candidates = candidateSwapPaths(token, req.side)
  const best = await quoteBestPath(router, amountIn, candidates)
  const path = best.path
  const expected = best.expectedOut

  // Telemetry: log the routing decision + how much output the WORSE path
  // would have produced, so we can audit later that the optimizer is
  // actually saving money. Cheap (already have the quotes in memory).
  if (candidates.length > 1) {
    try {
      const otherQuotes = await Promise.all(
        candidates
          .filter((p) => p !== path)
          .map(async (p) => {
            try {
              const out = (await router.getAmountsOut(amountIn, p)) as bigint[]
              return out[out.length - 1] ?? 0n
            } catch {
              return 0n
            }
          }),
      )
      const bestAlt = otherQuotes.reduce((acc, v) => (v > acc ? v : acc), 0n)
      if (bestAlt > 0n && expected > bestAlt) {
        const gainBps = ((expected - bestAlt) * 10_000n) / bestAlt
        logger.info(
          {
            userId,
            tokenSymbol: token.symbol,
            side: req.side,
            chosenRoute: best.label,
            hops: path.length - 1,
            gainBps: Number(gainBps),
          },
          '[personalWallet] best-path routing chose better quote',
        )
      }
    } catch {
      /* telemetry is best-effort */
    }
  }

  const minOut = (expected * (10000n - slippageBps)) / 10000n
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60)

  const walletAddr = signer.address.toLowerCase()
  async function erc20Bal(contract: string): Promise<bigint> {
    const c = new Contract(contract, erc20Abi, provider)
    return (await c.balanceOf(walletAddr)) as bigint
  }

  const usdtBefore = await erc20Bal(USDT_ADDR)
  const counterAddr = ledgerCounterAddress(token)
  const counterBefore = counterAddr ? await erc20Bal(counterAddr) : 0n

  const tx = (await router.swapExactTokensForTokens(
    amountIn,
    minOut,
    path,
    signer.address,
    deadline,
  )) as unknown as TransactionResponse
  await tx.wait(1)

  const usdtAfter = await erc20Bal(USDT_ADDR)
  const counterAfter = counterAddr ? await erc20Bal(counterAddr) : counterBefore

  const quotedOutNum = Number(formatUnits(expected, req.side === 'BUY' ? token.decimals : 18))
  const amountInNum = Number(formatUnits(amountIn, inDecimals))

  /** Fallback simulation price when balance deltas are unavailable (e.g. native BNB routing). */
  const simEntryPrice =
    req.side === 'BUY'
      ? amountInNum / Math.max(quotedOutNum, Number.EPSILON)
      : quotedOutNum / Math.max(amountInNum, Number.EPSILON)

  let allocationUsd = 0
  let entryPriceEff = 0
  // Slippage-vs-quote, kept around purely for the telemetry log below.
  // Used to be persisted as the trade's "pnl" field — that was the bug.
  let slippageVsQuoteUsd = 0

  if (counterAddr) {
    if (req.side === 'BUY') {
      const spentUsdt = Number(formatUnits(usdtBefore - usdtAfter, 18))
      const recvTok = Number(formatUnits(counterAfter - counterBefore, token.decimals))
      allocationUsd = Math.max(0, spentUsdt)
      entryPriceEff = recvTok > 1e-18 ? spentUsdt / recvTok : 0
      const tokUsd = (await fetchBinancePrice(token.binanceSymbol)) ?? (entryPriceEff > 0 ? entryPriceEff : 1)
      slippageVsQuoteUsd = (recvTok - quotedOutNum) * tokUsd
    } else {
      const recvUsdt = Number(formatUnits(usdtAfter - usdtBefore, 18))
      const soldTok = Number(formatUnits(counterBefore - counterAfter, token.decimals))
      allocationUsd = Math.max(0, recvUsdt)
      entryPriceEff = soldTok > 1e-18 ? recvUsdt / soldTok : 0
      slippageVsQuoteUsd = recvUsdt - quotedOutNum
    }
  } else {
    allocationUsd = req.side === 'BUY' ? Math.max(0, amountInNum) : Math.max(0, quotedOutNum)
    entryPriceEff = simEntryPrice
    slippageVsQuoteUsd = 0
  }

  const safeEntryPrice =
    Number.isFinite(entryPriceEff) && entryPriceEff > 0 ? entryPriceEff : Number.isFinite(simEntryPrice) ? simEntryPrice : 0

  // Surface execution quality as a structured log so operators can audit
  // route choice / slippage without it leaking into user-facing PnL.
  try {
    logger.info(
      {
        userId,
        tokenSymbol: token.symbol,
        side: req.side,
        effectiveExecPrice: safeEntryPrice,
        slippageVsQuoteUsd: Number.isFinite(slippageVsQuoteUsd)
          ? Math.round(slippageVsQuoteUsd * 1e8) / 1e8
          : 0,
        txHash: tx.hash,
      },
      '[personalWallet] swap filled',
    )
  } catch {
    /* logging is best-effort */
  }

  const safeAlloc = Number.isFinite(allocationUsd) ? Math.round(allocationUsd * 1e8) / 1e8 : 0

  const pair = `${token.symbol}/USDT`
  const strategyId = await ensurePersonalWalletStrategyId()

  // -------------------------------------------------------------------------
  // Position-lifecycle trade recording.
  //
  // Up until this rewrite, EVERY swap (BUY or SELL) was recorded as a
  // standalone `status: 'CLOSED'` row with `exitPrice: null` and
  // `pnl = recvTok - quotedOutNum` (i.e. just the slippage delta vs the
  // pre-trade quote). That's why investors saw a wall of rows in the trade
  // log all reading `Realized +$0.00`: the column was honest, but it was
  // showing slippage-vs-quote, not round-trip P&L.
  //
  // The real flow a trader expects is:
  //   1. BUY  → opens a position at fill price X (status=OPEN, pnl=null)
  //   2. SELL → closes the OLDEST open position for this pair, computes
  //             realized PnL = sellNotional − buyNotional, sets exitPrice
  //             to the sell fill price and flips the row to CLOSED.
  //
  // We get all of this WITHOUT a Prisma schema migration by leaning on the
  // existing `OPEN`/`CLOSED` TradeStatus enum + nullable `exitPrice`. After
  // the change:
  //   - OPEN rows  = still-held positions waiting for a SELL
  //   - CLOSED rows with exitPrice ≠ null = round-trip realized P&L
  //   - CLOSED rows with exitPrice = null = orphan SELL (no matching BUY,
  //     e.g. user sold tokens already in their wallet)
  //
  // `summarizeLedgerWindow` already filters on `status: CLOSED` and reads
  // `trade.pnl`, so the win-rate / expectancy / payoff widgets will start
  // showing real numbers immediately — they were getting zeros before only
  // because every row was a near-zero slippage delta.
  // -------------------------------------------------------------------------
  let recordedTrade: {
    id: string
    pair: string
    side: 'BUY' | 'SELL' | 'CLOSED'
    allocationUsd: number
    entryPrice: number
    exitPrice: number | null
    pnl: number | null
    status: 'OPEN' | 'CLOSED'
  }

  if (req.side === 'BUY') {
    const created = await prisma.trade.create({
      data: {
        userId,
        strategyId,
        pair,
        entryPrice: safeEntryPrice,
        exitPrice: null,
        // PnL is only realized at SELL time; leaving it null here keeps the
        // dashboard's "Realized" column showing "—" for unfinished positions
        // instead of a misleading "+$0.00".
        pnl: null,
        allocationUsd: safeAlloc > 0 ? safeAlloc : null,
        status: 'OPEN',
      },
    })
    recordedTrade = {
      id: created.id,
      pair,
      side: 'BUY',
      allocationUsd: safeAlloc,
      entryPrice: safeEntryPrice,
      exitPrice: null,
      pnl: null,
      status: 'OPEN',
    }
  } else {
    // SELL: find the oldest OPEN position for this (user, pair, strategy)
    // and close it with computed realized PnL. Using strategyId in the
    // lookup keeps "DEX Personal Wallet" books separate from manual
    // "DEX External Wallet" (MetaMask) books — a user can have one OPEN
    // position in each book simultaneously without them colliding.
    const openPos = req.closeTradeId
      ? await prisma.trade.findFirst({
          where: { id: req.closeTradeId, userId, pair, strategyId, status: 'OPEN' },
        })
      : await prisma.trade.findFirst({
          where: { userId, pair, strategyId, status: 'OPEN' },
          orderBy: { createdAt: 'asc' },
        })

    if (openPos) {
      const buyAlloc = Number(openPos.allocationUsd ?? 0)
      const buyEntry = Number(openPos.entryPrice)
      // Attribute PnL to the booked lot using fill prices (exit vs entry).
      // USDT balance deltas can include wallet dust / extra tokens and show
      // fake wins while exit < entry; fills match what investors see in the log.
      const realized = roundTripRealizedPnl(buyAlloc, buyEntry, safeEntryPrice)
      const usdtDelta = safeAlloc - buyAlloc
      if (Math.abs(usdtDelta - realized) > Math.max(buyAlloc * 0.15, 0.5)) {
        logger.warn(
          {
            userId,
            pair,
            buyAlloc,
            usdtDelta,
            fillPnl: realized,
            buyEntry,
            sellExit: safeEntryPrice,
          },
          '[personalWallet] sell USDT delta diverged from lot fill PnL — using fill-based PnL',
        )
      }

      const updated = await prisma.trade.update({
        where: { id: openPos.id },
        data: {
          exitPrice: safeEntryPrice,
          pnl: realized,
          status: 'CLOSED',
        },
      })
      recordedTrade = {
        id: updated.id,
        pair,
        side: 'CLOSED',
        allocationUsd: buyAlloc,
        entryPrice: Number(updated.entryPrice),
        exitPrice: safeEntryPrice,
        pnl: realized,
        status: 'CLOSED',
      }
    } else {
      // Orphan SELL — user sold tokens that weren't bought through this
      // book (e.g. pre-existing wallet balance, or a SELL after the user
      // manually cleared their history). We still record it so the audit
      // trail is complete, but PnL is null so it doesn't poison the
      // realized-PnL window. exitPrice stays null so the dashboard renders
      // the row as "standalone SELL" instead of a fake round-trip.
      const created = await prisma.trade.create({
        data: {
          userId,
          strategyId,
          pair,
          entryPrice: safeEntryPrice,
          exitPrice: null,
          pnl: null,
          allocationUsd: safeAlloc > 0 ? safeAlloc : null,
          status: 'CLOSED',
        },
      })
      recordedTrade = {
        id: created.id,
        pair,
        side: 'SELL',
        allocationUsd: safeAlloc,
        entryPrice: safeEntryPrice,
        exitPrice: null,
        pnl: null,
        status: 'CLOSED',
      }
    }
  }

  return {
    txHash: tx.hash,
    side: req.side,
    tokenSymbol: token.symbol,
    amountIn: formatUnits(amountIn, inDecimals),
    expectedOut: formatUnits(expected, req.side === 'BUY' ? token.decimals : 18),
    minOut: formatUnits(minOut, req.side === 'BUY' ? token.decimals : 18),
    trade: {
      id: recordedTrade.id,
      pair: recordedTrade.pair,
      // The pre-existing wire field was `allocationUsd, entryPrice, pnl`.
      // We preserve those keys for backwards compatibility (telegram /
      // socket consumers) and add `side`, `exitPrice`, `status` so newer
      // UI can render the full lifecycle.
      allocationUsd: recordedTrade.allocationUsd,
      entryPrice: recordedTrade.entryPrice,
      pnl: recordedTrade.pnl ?? 0,
      exitPrice: recordedTrade.exitPrice,
      side: recordedTrade.side,
      status: recordedTrade.status,
    },
  }
}

// ---- BSC same-chain convert (Pancake V2, no trade book) -------------------

const BSC_USDC_ADDR = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' as const

function tokenRouterAddr(token: BscTokenSpec): `0x${string}` {
  return (token.address ?? WBNB_ADDR) as `0x${string}`
}

/** Candidate Pancake paths for arbitrary token A → token B (deduped). */
function candidateConvertPaths(from: BscTokenSpec, to: BscTokenSpec): `0x${string}`[][] {
  const a = tokenRouterAddr(from)
  const b = tokenRouterAddr(to)
  if (a.toLowerCase() === b.toLowerCase()) return []
  const raw: `0x${string}`[][] = [
    [a, b],
    [a, USDT_ADDR, b],
    [a, WBNB_ADDR, b],
    [a, BSC_USDC_ADDR, b],
    [a, USDT_ADDR, WBNB_ADDR, b],
    [a, WBNB_ADDR, USDT_ADDR, b],
  ]
  const seen = new Set<string>()
  return raw.filter((p) => {
    const k = p.map((x) => x.toLowerCase()).join('-')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function findBscToken(symbol: string): BscTokenSpec {
  const token = PERSONAL_WALLET_TOKENS.find((t) => t.symbol === symbol.toUpperCase())
  if (!token) throw new Error(`Unsupported token ${symbol}`)
  return token
}

export type BscConvertPreview = {
  fromSymbol: string
  toSymbol: string
  inAmount: number
  outAmount: number
  rate: number
  /** Flat platform fee (USD) deducted from the input before the swap. */
  feeUsd?: number
}

export type BscConvertResult = {
  txHash: string
  fromSymbol: string
  toSymbol: string
  inAmount: number
  outAmount: number
  /** Flat platform fee (USD) deducted from the input before the swap. */
  feeUsd?: number
}

async function executeBscTokenSwap(
  userId: string,
  from: BscTokenSpec,
  to: BscTokenSpec,
  amount: number,
  slippageBps = 100,
): Promise<{ txHash: string; inAmount: number; outAmount: number }> {
  if (from.symbol === to.symbol) throw new Error('Choose two different tokens.')
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a valid amount.')

  const signer = await loadSigner(userId)
  const provider = getProvider()
  if (from.symbol !== 'BNB') {
    await ensureNativeBnbForGas(signer)
  }
  const router = new Contract(PANCAKE_V2_ROUTER, ROUTER_ABI, signer)
  const slippage = BigInt(Math.min(2000, Math.max(10, Math.floor(slippageBps))))

  const inDecimals = from.decimals
  const outDecimals = to.decimals
  let inToken = tokenRouterAddr(from)

  if (from.symbol === 'BNB') {
    const { sellable } = await readBnbBalancesRaw(provider, signer.address)
    let desired = parseUnits(amount.toFixed(Math.min(12, inDecimals)), inDecimals)
    if (desired > sellable) desired = sellable
    const wrapTarget = sellAmountRawFromBalance(desired > 0n ? desired : sellable)
    await ensureWbnbForSell(signer, wrapTarget)
    inToken = WBNB_ADDR
  }

  const erc20In = new Contract(inToken, erc20Abi, provider)
  const balance: bigint = (await erc20In.balanceOf(signer.address)) as bigint
  let amountIn = parseUnits(amount.toFixed(Math.min(12, inDecimals)), inDecimals)
  if (from.symbol === 'BNB') {
    if (amountIn > balance) amountIn = sellAmountRawFromBalance(balance)
  } else if (amountIn > balance) {
    amountIn = balance
  }
  if (amountIn <= 0n) {
    throw new Error(`Insufficient ${from.symbol} balance`)
  }

  const erc20Signer = new Contract(inToken, erc20Abi, signer)
  const allowance: bigint = (await erc20Signer.allowance(signer.address, PANCAKE_V2_ROUTER)) as bigint
  if (allowance < amountIn) {
    const approveTx = (await erc20Signer.approve(
      PANCAKE_V2_ROUTER,
      BigInt(2) ** BigInt(256) - BigInt(1),
    )) as TransactionResponse
    await approveTx.wait(1)
  }

  const fromForPath = from.symbol === 'BNB' ? PERSONAL_WALLET_TOKENS.find((t) => t.symbol === 'BNB')! : from
  const candidates = candidateConvertPaths(fromForPath, to)
  if (candidates.length === 0) throw new Error('No route between these tokens.')
  const best = await quoteBestPath(router, amountIn, candidates)
  const minOut = (best.expectedOut * (10000n - slippage)) / 10000n
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60)

  const outAddr = ledgerCounterAddress(to) ?? tokenRouterAddr(to)
  const outBefore = outAddr
    ? ((await new Contract(outAddr, erc20Abi, provider).balanceOf(signer.address)) as bigint)
    : 0n

  const tx = (await router.swapExactTokensForTokens(
    amountIn,
    minOut,
    best.path,
    signer.address,
    deadline,
  )) as unknown as TransactionResponse
  await tx.wait(1)

  const outAfter = outAddr
    ? ((await new Contract(outAddr, erc20Abi, provider).balanceOf(signer.address)) as bigint)
    : outBefore
  const delta = outAfter > outBefore ? outAfter - outBefore : best.expectedOut
  const inAmount = Number(formatUnits(amountIn, inDecimals))
  const outAmount = Number(formatUnits(delta, outDecimals))

  return { txHash: tx.hash, inAmount, outAmount }
}

/**
 * Platform convert fee in source-token units ($0.10 worth). Fail-soft: when the
 * token can't be priced the fee is skipped so the user's convert still works.
 */
async function bscConvertFeeTokens(from: BscTokenSpec, amount: number): Promise<number> {
  const price =
    from.symbol === 'USDT' || from.symbol === 'USDC' ? 1 : await fetchBinancePrice(from.binanceSymbol)
  if (!price || price <= 0) return 0
  const feeTokens = CONVERT_FEE_USD / price
  if (feeTokens >= amount * 0.2) {
    throw new Error(`Convert amount is too small — minimum is about $${(CONVERT_FEE_USD * 5).toFixed(2)}.`)
  }
  return feeTokens
}

/** Send the platform convert fee from the user's wallet to the fee treasury. */
async function chargeBscConvertFee(
  userId: string,
  from: BscTokenSpec,
  feeTokens: number,
): Promise<string | null> {
  if (!(feeTokens > 0)) return null
  const signer = await loadSigner(userId)
  const treasury = feeTreasuryBsc()
  if (from.symbol === 'BNB') {
    const tx = (await signer.sendTransaction({
      to: treasury,
      value: parseUnits(feeTokens.toFixed(12), 18),
    })) as TransactionResponse
    await tx.wait(1)
    return tx.hash
  }
  const token = new Contract(from.address!, erc20Abi, signer)
  const tx = (await token.transfer(treasury, parseUnits(feeTokens.toFixed(Math.min(12, from.decimals)), from.decimals))) as TransactionResponse
  await tx.wait(1)
  return tx.hash
}

/** All BSC tokens available as a Convert destination (holding not required). */
export function listBscConvertCatalog(): Array<{ symbol: string }> {
  return PERSONAL_WALLET_TOKENS.map((t) => ({ symbol: t.symbol }))
}

/** Quote-only BSC convert (no signing). Reflects the platform fee taken from the input. */
export async function previewBscConvert(req: {
  fromSymbol: string
  toSymbol: string
  amount: number
}): Promise<BscConvertPreview> {
  const from = findBscToken(req.fromSymbol)
  const to = findBscToken(req.toSymbol)
  if (from.symbol === to.symbol) throw new Error('Choose two different tokens.')
  if (!Number.isFinite(req.amount) || req.amount <= 0) throw new Error('Enter a valid amount.')

  const feeTokens = await bscConvertFeeTokens(from, req.amount)
  const netAmount = req.amount - feeTokens

  const provider = getProvider()
  const router = new Contract(PANCAKE_V2_ROUTER, ROUTER_ABI, provider)
  const amountIn = parseUnits(netAmount.toFixed(Math.min(12, from.decimals)), from.decimals)
  const candidates = candidateConvertPaths(from, to)
  if (candidates.length === 0) throw new Error('No route between these tokens.')
  const best = await quoteBestPath(router, amountIn, candidates)
  const inAmount = req.amount
  const outAmount = Number(formatUnits(best.expectedOut, to.decimals))
  return {
    fromSymbol: from.symbol,
    toSymbol: to.symbol,
    inAmount,
    outAmount,
    rate: inAmount > 0 ? outAmount / inAmount : 0,
    feeUsd: feeTokens > 0 ? CONVERT_FEE_USD : 0,
  }
}

/** Same-chain BSC convert — any supported token → any supported token via Pancake. */
export async function convertBscTokens(
  userId: string,
  req: { fromSymbol: string; toSymbol: string; amount: number; slippageBps?: number },
): Promise<BscConvertResult> {
  const from = findBscToken(req.fromSymbol)
  const to = findBscToken(req.toSymbol)

  // Platform fee ($0.10 in the source token) goes straight to the fee treasury.
  const feeTokens = await bscConvertFeeTokens(from, req.amount)
  const feeTxHash = await chargeBscConvertFee(userId, from, feeTokens).catch((err) => {
    logger.warn({ userId, from: from.symbol, err }, '[personal-wallet] convert fee charge failed — skipping fee')
    return null
  })
  const netAmount = feeTxHash ? req.amount - feeTokens : req.amount

  const { txHash, inAmount, outAmount } = await executeBscTokenSwap(
    userId,
    from,
    to,
    netAmount,
    req.slippageBps,
  )
  logger.info(
    { userId, from: from.symbol, to: to.symbol, txHash, feeTxHash, feeTokens },
    '[personal-wallet] BSC convert filled',
  )
  const { recordWalletConvert } = await import('./walletConvertHistoryService')
  await recordWalletConvert(userId, 'BSC', {
    fromSymbol: from.symbol,
    toSymbol: to.symbol,
    inAmount,
    outAmount,
    txRef: txHash,
  }).catch(() => undefined)
  return {
    txHash,
    fromSymbol: from.symbol,
    toSymbol: to.symbol,
    inAmount: feeTxHash ? inAmount + feeTokens : inAmount,
    outAmount,
    feeUsd: feeTxHash ? CONVERT_FEE_USD : 0,
  }
}

/** Swap a BSC wallet token into USDC (used before cross-chain bridge). */
export async function swapBscTokenToUsdc(
  userId: string,
  fromSymbol: string,
  amount: number,
): Promise<{ usdcAmount: number; swapTxHash: string | null }> {
  const sym = fromSymbol.toUpperCase()
  if (sym === 'USDC') {
    return { usdcAmount: amount, swapTxHash: null }
  }
  const usdcToken = findBscToken('USDC')
  const from = findBscToken(sym)
  const { txHash, outAmount } = await executeBscTokenSwap(userId, from, usdcToken, amount)
  return { usdcAmount: outAmount, swapTxHash: txHash }
}

/** Read-only quote: how much USDC you'd get swapping `amount` of `fromSymbol`. */
export async function quoteBscTokenToUsdc(fromSymbol: string, amount: number): Promise<number> {
  const sym = fromSymbol.toUpperCase()
  if (sym === 'USDC') return amount
  const preview = await previewBscConvert({ fromSymbol: sym, toSymbol: 'USDC', amount })
  return preview.outAmount
}
