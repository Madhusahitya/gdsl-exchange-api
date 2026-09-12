/**
 * Server-managed Solana wallet for Jupiter DEX — isolated from BSC PersonalWallet.
 */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  type ParsedAccountData,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import {
  getAssociatedTokenAddress,
  getAccount,
  getMint,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import { prisma, PersonalWalletWithdrawalStatus } from '@cryptoflow/db'
import { decryptSecret, encryptSecret, isWalletCryptoConfigured } from '../../lib/walletCrypto'
import { logger } from '../../lib/logger'
import { SOL_USDC_MINT, SOL_NATIVE_MINT } from '../../lib/solDexCatalog'
import { fetchJupiterPricesV3Batched } from '../dex/jupiterPriceService'

const USDC_DECIMALS = 6
/** Circle USDC + native USDT — treat as $1 for portfolio floors. */
const SOL_STABLE_MINTS = new Set([
  SOL_USDC_MINT,
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
])
/** Keep this much SOL behind for transaction fees + ATA rent on withdrawals. */
const SOLANA_GAS_RESERVE_SOL = 0.003
/** Assets that can be withdrawn out of the Solana personal wallet. */
export const SOLANA_WITHDRAW_ASSETS = ['USDC', 'SOL'] as const
export type SolanaWithdrawAsset = (typeof SOLANA_WITHDRAW_ASSETS)[number]

import { getSolanaConnection, withSolanaRpc } from '../solana/solanaRpcPool'

function getConnection(): Connection {
  return getSolanaConnection()
}

function parseTokenAccountInfo(account: {
  data: ParsedAccountData | unknown
}): SolanaHolding | null {
  const info = (account.data as ParsedAccountData).parsed?.info as
    | {
        mint?: string
        tokenAmount?: {
          uiAmount?: number | null
          amount?: string
          decimals?: number
        }
      }
    | undefined
  const mint = info?.mint
  const decimals = info?.tokenAmount?.decimals
  if (!mint || decimals == null) return null
  let amount = info?.tokenAmount?.uiAmount ?? null
  if (amount == null || !Number.isFinite(amount)) {
    const raw = info?.tokenAmount?.amount
    amount = raw != null ? Number(raw) / 10 ** decimals : null
  }
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return null
  return { mint, amount, decimals }
}

export function isSolanaWalletEnabled(): boolean {
  return isWalletCryptoConfigured()
}

export async function ensureSolanaPersonalWallet(
  userId: string,
): Promise<{ address: string; created: boolean }> {
  if (!isSolanaWalletEnabled()) {
    throw new Error('Solana wallet is not configured (WALLET_ENCRYPTION_KEY missing).')
  }
  const existing = await prisma.solanaPersonalWallet.findUnique({ where: { userId } })
  if (existing) return { address: existing.address, created: false }

  const kp = Keypair.generate()
  const address = kp.publicKey.toBase58()
  const encryptedPrivateKey = encryptSecret(Buffer.from(kp.secretKey).toString('base64'))

  await prisma.solanaPersonalWallet.create({
    data: { userId, address, encryptedPrivateKey },
  })
  logger.info(`[solana-wallet] created wallet for user ${userId} at ${address}`)
  return { address, created: true }
}

export async function getSolanaWalletStatus(userId: string): Promise<{
  configured: boolean
  wallet: { address: string; enabled: boolean } | null
}> {
  if (!isSolanaWalletEnabled()) {
    return { configured: false, wallet: null }
  }
  const row = await prisma.solanaPersonalWallet.findUnique({ where: { userId } })
  if (!row) return { configured: true, wallet: null }
  return {
    configured: true,
    wallet: { address: row.address, enabled: row.enabled },
  }
}

export async function getSolanaKeypair(userId: string): Promise<Keypair> {
  const row = await prisma.solanaPersonalWallet.findUnique({ where: { userId } })
  if (!row) throw new Error('Solana personal wallet not found — open DEX Jupiter to create one.')
  if (!row.enabled) throw new Error('Solana personal wallet is disabled')
  const raw = decryptSecret(row.encryptedPrivateKey)
  const secret = Buffer.from(raw, 'base64')
  if (secret.length !== 64) throw new Error('Invalid Solana key material')
  return Keypair.fromSecretKey(new Uint8Array(secret))
}

async function fetchBinancePrice(binanceSymbol: string | null): Promise<number | null> {
  if (!binanceSymbol) return null
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${binanceSymbol}`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!r.ok) return null
    const data = (await r.json()) as { price?: string }
    const price = data.price ? parseFloat(data.price) : NaN
    return Number.isFinite(price) && price > 0 ? price : null
  } catch {
    return null
  }
}

export type SolanaBalanceSnapshot = {
  sol: number
  usdc: number
  totalUsd: number
}

export async function getSolanaBalances(userId: string): Promise<SolanaBalanceSnapshot> {
  const kp = await getSolanaKeypair(userId)
  const conn = getConnection()
  const owner = kp.publicKey
  const lamports = await conn.getBalance(owner)
  const sol = lamports / LAMPORTS_PER_SOL

  let usdc = 0
  try {
    const mint = new PublicKey(SOL_USDC_MINT)
    const ata = await getAssociatedTokenAddress(mint, owner)
    const acc = await getAccount(conn, ata)
    usdc = Number(acc.amount) / 10 ** USDC_DECIMALS
  } catch {
    usdc = 0
  }

  // Full portfolio USD — every held SPL + native SOL (not USDC-only).
  // When RPC token enumeration fails/times out, holdings may omit USDC even
  // though the ATA read above succeeded — never let totalUsd fall below known cash.
  const holdings = await listSolanaHoldings(userId)
  const priceMap = await fetchJupiterPricesV3Batched(holdings.map((h) => h.mint)).catch(
    () => new Map<string, { usdPrice?: number }>(),
  )
  let totalUsd = 0
  let pricedUsdc = false
  for (const h of holdings) {
    const usdPrice = SOL_STABLE_MINTS.has(h.mint) ? 1 : priceMap.get(h.mint)?.usdPrice ?? 0
    if (h.mint === SOL_USDC_MINT) pricedUsdc = true
    if (usdPrice > 0) totalUsd += h.amount * usdPrice
  }
  // Floor with ATA USDC (+ native SOL mark) so the dashboard never shows $0.00
  // while the USDC line item is non-zero.
  if (!pricedUsdc && usdc > 0) totalUsd += usdc
  const solPrice =
    priceMap.get(SOL_NATIVE_MINT)?.usdPrice ??
    (await fetchBinancePrice('SOLUSDT').catch(() => null)) ??
    0
  const solFloor = sol > 0 && solPrice > 0 ? sol * solPrice : 0
  const cashFloor = usdc + solFloor
  if (totalUsd < cashFloor) totalUsd = cashFloor
  return { sol, usdc, totalUsd }
}

export type SolanaWalletTokenRow = {
  mint: string
  symbol: string
  icon: string | null
  amount: number
  decimals: number
  usdPrice: number
  usdValue: number
}

/** One RPC + one price fetch for dashboard (replaces parallel /balances + /tokens). */
export async function getSolanaWalletDashboardSummary(userId: string): Promise<{
  address: string | null
  sol: number
  usdc: number
  totalUsd: number
  tokens: SolanaWalletTokenRow[]
  supportedAssets: typeof SOLANA_WITHDRAW_ASSETS
}> {
  const empty = {
    address: null as string | null,
    sol: 0,
    usdc: 0,
    totalUsd: 0,
    tokens: [] as SolanaWalletTokenRow[],
    supportedAssets: SOLANA_WITHDRAW_ASSETS,
  }
  const status = await getSolanaWalletStatus(userId)
  if (!status.wallet) return empty

  const holdings = await listSolanaHoldings(userId)
  const byMint = new Map(holdings.map((h) => [h.mint, h]))
  if (!byMint.has(SOL_USDC_MINT)) {
    const usdcAmt = await getSolanaTokenBalance(userId, SOL_USDC_MINT, 6).catch(() => 0)
    if (usdcAmt > 0) {
      byMint.set(SOL_USDC_MINT, { mint: SOL_USDC_MINT, amount: usdcAmt, decimals: 6 })
    }
  }
  const merged = [...byMint.values()]
  const priceMap = await fetchJupiterPricesV3Batched(merged.map((h) => h.mint)).catch(
    () => new Map<string, { usdPrice?: number }>(),
  )
  const { getJupiterTradableRegistry } = await import('../dex/jupiterTradableRegistry')
  const reg = await getJupiterTradableRegistry().catch(() => ({ tokens: [] }))
  const metaByMint = new Map<string, { symbol: string; icon: string | null }>()
  for (const t of reg.tokens) metaByMint.set(t.mint, { symbol: t.baseSymbol, icon: t.iconUrl ?? null })
  metaByMint.set(SOL_USDC_MINT, { symbol: 'USDC', icon: null })
  metaByMint.set(SOL_NATIVE_MINT, { symbol: 'SOL', icon: null })

  const tokens: SolanaWalletTokenRow[] = merged.map((h) => {
    const usdPrice = SOL_STABLE_MINTS.has(h.mint) ? 1 : priceMap.get(h.mint)?.usdPrice ?? 0
    const meta = metaByMint.get(h.mint)
    return {
      mint: h.mint,
      symbol: meta?.symbol ?? `${h.mint.slice(0, 4)}…${h.mint.slice(-4)}`,
      icon: meta?.icon ?? null,
      amount: h.amount,
      decimals: h.decimals,
      usdPrice,
      usdValue: usdPrice > 0 ? h.amount * usdPrice : 0,
    }
  })
  tokens.sort((a, b) => b.usdValue - a.usdValue)

  const sol = holdings.find((h) => h.mint === SOL_NATIVE_MINT)?.amount ?? 0
  const usdc = byMint.get(SOL_USDC_MINT)?.amount ?? 0
  let totalUsd = tokens.reduce((s, t) => s + t.usdValue, 0)
  const solPrice =
    priceMap.get(SOL_NATIVE_MINT)?.usdPrice ??
    (await fetchBinancePrice('SOLUSDT').catch(() => null)) ??
    0
  const cashFloor = usdc + (sol > 0 && solPrice > 0 ? sol * solPrice : 0)
  if (totalUsd < cashFloor) totalUsd = cashFloor

  return {
    address: status.wallet.address,
    sol,
    usdc,
    totalUsd,
    tokens,
    supportedAssets: SOLANA_WITHDRAW_ASSETS,
  }
}

const tokenProgramCache = new Map<string, string>()

/**
 * Which token program owns a mint — legacy SPL Token or Token-2022. Many newer
 * meme/momentum tokens are Token-2022; reading their balance/ATA with the legacy
 * program silently returns 0, which is why a held coin can show as "0.00000".
 */
async function getTokenProgramId(mintPk: PublicKey): Promise<PublicKey> {
  const key = mintPk.toBase58()
  const cached = tokenProgramCache.get(key)
  if (cached) return new PublicKey(cached)
  const info = await getConnection().getAccountInfo(mintPk)
  const pid = info?.owner && info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
  tokenProgramCache.set(key, pid.toBase58())
  return pid
}

/** Raw token balance for a mint (human units). Handles legacy + Token-2022. */
export async function getSolanaTokenBalance(
  userId: string,
  mint: string,
  decimals: number,
): Promise<number> {
  const kp = await getSolanaKeypair(userId)
  const conn = getConnection()
  if (mint === SOL_NATIVE_MINT) {
    const lamports = await conn.getBalance(kp.publicKey)
    return lamports / LAMPORTS_PER_SOL
  }
  try {
    const mintPk = new PublicKey(mint)
    const programId = await getTokenProgramId(mintPk)
    const ata = await getAssociatedTokenAddress(mintPk, kp.publicKey, false, programId)
    const acc = await getAccount(conn, ata, undefined, programId)
    return Number(acc.amount) / 10 ** decimals
  } catch {
    return 0
  }
}

const mintDecimalsCache = new Map<string, number>()

/** On-chain decimals for any SPL mint (cached). USDC/SOL are known constants. */
export async function getSolanaMintDecimals(mint: string): Promise<number> {
  if (mint === SOL_NATIVE_MINT) return 9
  if (mint === SOL_USDC_MINT) return USDC_DECIMALS
  const cached = mintDecimalsCache.get(mint)
  if (cached != null) return cached
  const mintPk = new PublicKey(mint)
  const programId = await getTokenProgramId(mintPk)
  const info = await getMint(getConnection(), mintPk, undefined, programId)
  mintDecimalsCache.set(mint, info.decimals)
  return info.decimals
}

export type SolanaHolding = { mint: string; amount: number; decimals: number }

/** Last-good SPL snapshot — survives public RPC empty/429 blips that caused Convert "no coins". */
const holdingsLastGood = new Map<
  string,
  { holdings: SolanaHolding[]; splCount: number; at: number }
>()
const HOLDINGS_LAST_GOOD_TTL_MS = 10 * 60_000
/** Coalesce parallel balances+tokens polls into one RPC enumeration. */
const holdingsInflight = new Map<string, Promise<SolanaHolding[]>>()

function splCountOf(holdings: SolanaHolding[]): number {
  return holdings.filter((h) => h.mint !== SOL_NATIVE_MINT).length
}

/**
 * Every SPL token (plus native SOL) the user's Solana wallet actually holds.
 * Powers the wallet page, dashboard All-chains total, and Jupiter pay-with picker.
 *
 * Uses RPC failover + last-good cache so a flaky getTokenAccountsByOwner blip
 * never collapses a full portfolio to USDC-only / empty (Convert "no coins").
 */
export async function listSolanaHoldings(userId: string): Promise<SolanaHolding[]> {
  const kp = await getSolanaKeypair(userId)
  return listSolanaHoldingsForOwner(kp.publicKey)
}

/**
 * Same enumeration for any Solana address, so a connected browser wallet can be
 * displayed with the identical failover and last-good behaviour as the platform
 * wallet. Read-only — holding an address grants no signing ability.
 */
export async function listSolanaHoldingsForOwner(
  ownerAddress: PublicKey | string,
): Promise<SolanaHolding[]> {
  const owner = typeof ownerAddress === 'string' ? new PublicKey(ownerAddress) : ownerAddress
  const cacheKey = owner.toBase58()

  const inflight = holdingsInflight.get(cacheKey)
  if (inflight) return inflight

  const run = (async () => {
    const holdings: SolanaHolding[] = []

    const lamports = await withSolanaRpc((conn) => conn.getBalance(owner)).catch(async () =>
      getConnection().getBalance(owner),
    )
    const sol = lamports / LAMPORTS_PER_SOL
    if (sol > 0) holdings.push({ mint: SOL_NATIVE_MINT, amount: sol, decimals: 9 })

    const byMint = new Map<string, SolanaHolding>()
    let legacyOk = false

    const mergeAccounts = (
      accounts: Array<{ account: { data: ParsedAccountData | unknown } }>,
    ) => {
      for (const { account } of accounts) {
        const row = parseTokenAccountInfo(account)
        if (!row) continue
        const prev = byMint.get(row.mint)
        if (!prev || row.amount > prev.amount) byMint.set(row.mint, row)
      }
    }

    try {
      const legacy = await withSolanaRpc((conn) =>
        conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
      )
      mergeAccounts(legacy.value)
      legacyOk = true
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), owner: owner.toBase58() },
        '[solana-wallet] legacy token enumeration failed',
      )
    }

    try {
      const token22 = await withSolanaRpc((conn) =>
        conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
      )
      mergeAccounts(token22.value)
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), owner: owner.toBase58() },
        '[solana-wallet] Token-2022 enumeration failed',
      )
    }

    for (const row of byMint.values()) holdings.push(row)
    const splCount = byMint.size
    const cached = holdingsLastGood.get(cacheKey)
    const cacheFresh = cached != null && Date.now() - cached.at < HOLDINGS_LAST_GOOD_TTL_MS

    // Partial collapse (e.g. only USDC after RPC blip) → serve last-good richer list.
    if (cacheFresh && cached.splCount > splCount + 1) {
      logger.warn(
        {
          owner: owner.toBase58(),
          liveSpl: splCount,
          cachedSpl: cached.splCount,
          legacyOk,
        },
        '[solana-wallet] serving last-good holdings (live enumeration shrank)',
      )
      const merged = cached.holdings.map((h) =>
        h.mint === SOL_NATIVE_MINT && sol > 0 ? { ...h, amount: sol } : h,
      )
      if (sol > 0 && !merged.some((h) => h.mint === SOL_NATIVE_MINT)) {
        merged.unshift({ mint: SOL_NATIVE_MINT, amount: sol, decimals: 9 })
      }
      return merged
    }

    if (!legacyOk && cacheFresh && cached.splCount > 0) {
      logger.warn(
        { owner: owner.toBase58(), cachedSpl: cached.splCount },
        '[solana-wallet] legacy enum failed — serving last-good holdings',
      )
      return cached.holdings.map((h) =>
        h.mint === SOL_NATIVE_MINT && sol > 0 ? { ...h, amount: sol } : h,
      )
    }

    if (splCount > 0 || !cacheFresh) {
      holdingsLastGood.set(cacheKey, { holdings: [...holdings], splCount, at: Date.now() })
    }

    if (splCount === 0) {
      logger.warn(
        { owner: owner.toBase58() },
        '[solana-wallet] no SPL accounts found — portfolio may under-report vs Solscan',
      )
    }

    return holdings
  })()

  holdingsInflight.set(cacheKey, run)
  try {
    return await run
  } finally {
    holdingsInflight.delete(cacheKey)
  }
}

/** Parse + validate a destination Solana address (base58, on-curve). */
function parseSolanaAddress(raw: string): PublicKey {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) throw new Error('Destination address is required')
  let pk: PublicKey
  try {
    pk = new PublicKey(trimmed)
  } catch {
    throw new Error('Invalid Solana address')
  }
  if (!PublicKey.isOnCurve(pk.toBytes())) {
    throw new Error('Address is not a valid wallet (looks like a program/PDA)')
  }
  return pk
}

export type SolanaWithdrawRequest = {
  asset: string
  amount: number
  toAddress: string
}

/** Server-signed withdrawal of USDC or SOL out of the user's Solana personal wallet. */
export async function withdrawFromSolanaWallet(
  userId: string,
  req: SolanaWithdrawRequest,
): Promise<{ id: string; txSignature: string; status: PersonalWalletWithdrawalStatus }> {
  if (!isSolanaWalletEnabled()) {
    throw new Error('Solana wallet is not configured (WALLET_ENCRYPTION_KEY missing).')
  }
  const asset = req.asset.toUpperCase()
  if (!SOLANA_WITHDRAW_ASSETS.includes(asset as SolanaWithdrawAsset)) {
    throw new Error(`Unsupported asset ${req.asset}. Withdraw USDC or SOL.`)
  }
  if (!Number.isFinite(req.amount) || req.amount <= 0) {
    throw new Error('Amount must be positive')
  }
  const dest = parseSolanaAddress(req.toAddress)

  const walletRow = await prisma.solanaPersonalWallet.findUnique({ where: { userId } })
  if (!walletRow) throw new Error('Solana personal wallet not found')
  if (!walletRow.enabled) throw new Error('Solana personal wallet is disabled')

  const kp = await getSolanaKeypair(userId)
  const conn = getConnection()
  const owner = kp.publicKey

  if (owner.equals(dest)) {
    throw new Error('Destination is your own wallet — pick an external address')
  }

  // Pre-flight balance checks so we never broadcast a doomed transfer.
  const lamports = await conn.getBalance(owner)
  const solBalance = lamports / LAMPORTS_PER_SOL
  if (asset === 'SOL') {
    const maxSendable = solBalance - SOLANA_GAS_RESERVE_SOL
    if (req.amount > maxSendable) {
      throw new Error(
        `Insufficient SOL — available ${Math.max(0, maxSendable).toFixed(6)} after gas reserve, requested ${req.amount}`,
      )
    }
  } else if (solBalance < SOLANA_GAS_RESERVE_SOL) {
    throw new Error(
      `Need a little SOL for network fees — wallet has ${solBalance.toFixed(6)} SOL. Deposit ~0.01 SOL first.`,
    )
  }

  const record = await prisma.solanaPersonalWalletWithdrawal.create({
    data: {
      walletId: walletRow.id,
      userId,
      toAddress: dest.toBase58(),
      asset,
      amount: req.amount,
      status: PersonalWalletWithdrawalStatus.PROCESSING,
    },
  })

  try {
    const tx = new Transaction()
    if (asset === 'SOL') {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: dest,
          lamports: Math.floor(req.amount * LAMPORTS_PER_SOL),
        }),
      )
    } else {
      const mint = new PublicKey(SOL_USDC_MINT)
      const sourceAta = await getAssociatedTokenAddress(mint, owner)
      let sourceAmount = 0n
      try {
        const acc = await getAccount(conn, sourceAta)
        sourceAmount = acc.amount
      } catch {
        throw new Error('No USDC balance in this wallet')
      }
      const requiredRaw = BigInt(Math.floor(req.amount * 10 ** USDC_DECIMALS))
      if (sourceAmount < requiredRaw) {
        throw new Error(
          `Insufficient USDC — available ${(Number(sourceAmount) / 10 ** USDC_DECIMALS).toFixed(2)}, requested ${req.amount}`,
        )
      }
      const destAta = await getAssociatedTokenAddress(mint, dest)
      // Create the recipient's USDC account if they've never held USDC (server pays rent).
      try {
        await getAccount(conn, destAta)
      } catch {
        tx.add(createAssociatedTokenAccountInstruction(owner, destAta, dest, mint))
      }
      tx.add(createTransferInstruction(sourceAta, destAta, owner, requiredRaw))
    }

    const signature = await sendAndConfirmTransaction(conn, tx, [kp], {
      commitment: 'confirmed',
      maxRetries: 3,
    })

    const updated = await prisma.solanaPersonalWalletWithdrawal.update({
      where: { id: record.id },
      data: {
        txSignature: signature,
        status: PersonalWalletWithdrawalStatus.COMPLETED,
        processedAt: new Date(),
      },
    })
    logger.info(`[solana-wallet] withdrew ${req.amount} ${asset} for ${userId} → ${dest.toBase58()} (${signature})`)
    return { id: updated.id, txSignature: signature, status: updated.status }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Withdrawal failed'
    await prisma.solanaPersonalWalletWithdrawal.update({
      where: { id: record.id },
      data: {
        status: PersonalWalletWithdrawalStatus.FAILED,
        errorMessage: message.slice(0, 500),
        processedAt: new Date(),
      },
    })
    throw new Error(message)
  }
}

/**
 * Send any held token (or native SOL) from the user's Solana wallet to an
 * arbitrary address. Used for the platform convert fee → fee treasury.
 * Handles token-2022 mints and creates the destination ATA when missing.
 */
export async function sendSolanaTokenFromUser(
  userId: string,
  mint: string,
  amount: number,
  toAddress: string,
): Promise<string> {
  const kp = await getSolanaKeypair(userId)
  const conn = getConnection()
  const owner = kp.publicKey
  const dest = new PublicKey(toAddress)

  const tx = new Transaction()
  if (mint === SOL_NATIVE_MINT) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: dest,
        lamports: Math.floor(amount * LAMPORTS_PER_SOL),
      }),
    )
  } else {
    const mintPk = new PublicKey(mint)
    const info = await conn.getAccountInfo(mintPk)
    const programId = info?.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
    const decimals = await getSolanaMintDecimals(mint)
    const sourceAta = await getAssociatedTokenAddress(mintPk, owner, false, programId)
    const raw = BigInt(Math.floor(amount * 10 ** decimals))
    const acc = await getAccount(conn, sourceAta, undefined, programId)
    if (acc.amount < raw) throw new Error('Insufficient token balance for fee')
    const destAta = await getAssociatedTokenAddress(mintPk, dest, false, programId)
    try {
      await getAccount(conn, destAta, undefined, programId)
    } catch {
      tx.add(createAssociatedTokenAccountInstruction(owner, destAta, dest, mintPk, programId))
    }
    tx.add(createTransferInstruction(sourceAta, destAta, owner, raw, [], programId))
  }

  return sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed', maxRetries: 3 })
}

export async function listSolanaWithdrawals(userId: string, limit = 25) {
  return prisma.solanaPersonalWalletWithdrawal.findMany({
    where: { userId },
    orderBy: { requestedAt: 'desc' },
    take: Math.min(100, Math.max(1, limit)),
  })
}
