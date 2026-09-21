/**
 * Cross-chain same-token transfer between BSC and Solana personal wallets:
 *
 *   leg 1 (debit):  user source wallet  → operator wallet on source chain (user signs)
 *   leg 2 (credit): operator bridges via LI.FI → user destination wallet (operator signs)
 *
 * Example: 0.01 ETH on BSC → ~0.01 ETH (minus platform fee) on Solana.
 * No pre-funded destination inventory is required — your tokens fund the bridge.
 */
import { Contract, formatUnits, parseEther, parseUnits, type TransactionResponse, type Wallet } from 'ethers'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import { prisma, CrossChainTransferStatus } from '@cryptoflow/db'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import {
  isSameTokenCrossChainSupported,
  listCrossChainSupportedSymbols,
  resolveCrossChainRoute,
  toCanonicalCrossChainSymbol,
  type CrossChainBscLeg,
  type CrossChainSolLeg,
  type CrossChainRoute,
} from '../../lib/crossChainTokenCatalog'
import { SOL_USDC_MINT } from '../../lib/solDexCatalog'
import { feeTreasuryBsc, feeTreasurySol } from '../../lib/feeTreasury'
import { getBscJsonRpcProvider, getHotWalletSigner } from './hotWalletConfig'
import { getPersonalSigner, ensureNativeBnbForGas } from './personalWalletService'
import {
  ensureSolanaPersonalWallet,
  getSolanaKeypair,
  isSolanaWalletEnabled,
  listSolanaHoldings,
} from './solanaPersonalWalletService'

export const CROSS_CHAIN_DIRECTIONS = ['BSC_TO_SOL', 'SOL_TO_BSC'] as const
export type CrossChainDirection = (typeof CROSS_CHAIN_DIRECTIONS)[number]

/** Binance-Peg USD Coin on BSC. NOTE: 18 decimals (unlike 6-decimal USDC elsewhere). */
const BSC_USDC_ADDRESS = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'
/** Flat USD settlement fee (deducted from credit in the same token). */
const TRANSFER_FEE_USD = 0.1
const MIN_TRANSFER_USD = 1
const MAX_TRANSFER_USD = 5_000
/** Operator BSC hot wallet needs native BNB to bridge ERC-20 to Solana. */
const MIN_OPERATOR_BNB_FOR_BRIDGE = parseEther('0.001')

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]

let solConn: Connection | null = null
function conn(): Connection {
  if (!solConn) {
    solConn = new Connection(env.SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com', 'confirmed')
  }
  return solConn
}

/** Operator Solana pool keypair from env, or null if unconfigured/malformed. */
function operatorSolanaKeypair(): Keypair | null {
  const raw = process.env.SOLANA_HOT_WALLET_PRIVATE_KEY?.trim()
  if (!raw) return null
  try {
    let bytes: Uint8Array | null = null
    if (raw.startsWith('[')) {
      bytes = Uint8Array.from(JSON.parse(raw) as number[])
    } else {
      const buf = Buffer.from(raw, 'base64')
      if (buf.length === 64) bytes = new Uint8Array(buf)
    }
    if (!bytes || bytes.length !== 64) return null
    return Keypair.fromSecretKey(bytes)
  } catch {
    return null
  }
}

export function isCrossChainTransferEnabled(): boolean {
  return Boolean(getHotWalletSigner()) && Boolean(operatorSolanaKeypair()) && isSolanaWalletEnabled()
}

export type CrossChainQuote = {
  asset: string
  amount: number
  feeUsd: number
  creditAmount: number
  minAmount: number
  maxAmount: number
  destinationSymbol: string
  /** True when the destination coin differs from the source (swap + bridge). */
  estimated?: boolean
}

export type CrossChainSourceAsset = {
  symbol: string
  balance: number
  usdValue: number | null
  crossChainReady: boolean
  hint: string | null
  destinationSymbol: string | null
}

export type CrossChainTransferPreview = CrossChainQuote & {
  sourceSymbol: string
  sourceAmount: number
  tokenUsdPrice: number | null
  destTokenUsdPrice?: number | null
}

/** USD price for a bridge leg via Binance spot (stables pinned to $1). */
async function fetchLegUsdPrice(binanceSymbol: string): Promise<number | null> {
  const sym = binanceSymbol.toUpperCase()
  if (sym === 'USDCUSDT' || sym === 'USDTUSDT' || sym === 'USDCUSDC' || sym === 'USDTUSDC') return 1
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) return null
    const j = (await r.json()) as { price?: string }
    const p = Number(j.price)
    return Number.isFinite(p) && p > 0 ? p : null
  } catch {
    return null
  }
}

export type CrossChainStatusPayload = {
  enabled: boolean
  feeUsd: number
  minAmount: number
  maxAmount: number
  directions: CrossChainDirection[]
  message: string | null
  operatorLiquidity?: { bscUsdc: number; solUsdc: number }
  operatorAddresses?: { bsc: string; solana: string }
  supportedSymbols?: string[]
}

export async function getCrossChainStatusPayload(
  userId?: string,
  direction?: CrossChainDirection,
): Promise<CrossChainStatusPayload> {
  const enabled = isCrossChainTransferEnabled()
  const quote = getCrossChainQuote(1, 'USDC', 1, 6)
  const base: CrossChainStatusPayload = {
    enabled,
    feeUsd: quote.feeUsd,
    minAmount: quote.minAmount,
    maxAmount: quote.maxAmount,
    directions: [...CROSS_CHAIN_DIRECTIONS],
    supportedSymbols: listCrossChainSupportedSymbols(),
    message: enabled
      ? null
      : 'Cross-chain transfer is not available on this server (operator bridge wallets not configured).',
  }
  if (!enabled) return base

  const opBsc = getHotWalletSigner()
  const opSol = operatorSolanaKeypair()
  if (opBsc && opSol) {
    const [bscUsdc, solUsdc] = await Promise.all([
      bscUsdcBalance(opBsc.address),
      solUsdcBalance(opSol.publicKey.toBase58()),
    ])
    base.operatorLiquidity = {
      bscUsdc: Math.round(bscUsdc * 100) / 100,
      solUsdc: Math.round(solUsdc * 100) / 100,
    }
    base.operatorAddresses = {
      bsc: opBsc.address,
      solana: opSol.publicKey.toBase58(),
    }
  }

  if (userId && direction) {
    try {
      await ensureSolanaPersonalWallet(userId)
    } catch {
      /* optional enrichment */
    }
  }

  return base
}

export async function listCrossChainSourceAssets(
  userId: string,
  direction: CrossChainDirection,
): Promise<CrossChainSourceAsset[]> {
  await ensureSolanaPersonalWallet(userId)
  const items: CrossChainSourceAsset[] = []

  if (direction === 'BSC_TO_SOL') {
    const { getPersonalWalletSummary } = await import('./personalWalletService')
    const summary = await getPersonalWalletSummary(userId)
    for (const a of summary?.balances ?? []) {
      const bal = Number(a.amount ?? 0)
      if (bal <= 0) continue
      const sym = a.asset.toUpperCase()
      const canonical = toCanonicalCrossChainSymbol(sym)
      const supported = isSameTokenCrossChainSupported(sym)
      items.push({
        symbol: sym,
        balance: bal,
        usdValue: a.usdValue != null ? Number(a.usdValue) : null,
        crossChainReady: supported,
        destinationSymbol: supported ? canonical : null,
        hint: supported
          ? `Delivers ${canonical} on Solana (same token, different network).`
          : `${sym} cannot move cross-chain yet — use Convert to USDC first.`,
      })
    }
  } else {
    const { fetchJupiterPricesV3 } = await import('../dex/jupiterPriceService')
    const { getJupiterTradableRegistry } = await import('../dex/jupiterTradableRegistry')
    const holdings = await listSolanaHoldings(userId)
    const priceMap = await fetchJupiterPricesV3(holdings.map((h) => h.mint)).catch(
      () => new Map<string, { usdPrice?: number }>(),
    )
    const reg = await getJupiterTradableRegistry().catch(() => ({ tokens: [] as Array<{ mint: string; baseSymbol: string }> }))
    const metaByMint = new Map<string, string>()
    for (const t of reg.tokens) metaByMint.set(t.mint, t.baseSymbol)
    metaByMint.set(SOL_USDC_MINT, 'USDC')
    metaByMint.set('So11111111111111111111111111111111111111112', 'SOL')

    for (const h of holdings) {
      if (h.amount <= 0) continue
      const sym = (metaByMint.get(h.mint) ?? h.mint.slice(0, 4)).toUpperCase()
      const usdPrice = h.mint === SOL_USDC_MINT ? 1 : priceMap.get(h.mint)?.usdPrice ?? 0
      const usdValue = usdPrice > 0 ? h.amount * usdPrice : null
      const supported = isSameTokenCrossChainSupported(sym)
      const canonical = toCanonicalCrossChainSymbol(sym)
      items.push({
        symbol: sym,
        balance: h.amount,
        usdValue,
        crossChainReady: supported,
        destinationSymbol: supported ? canonical : null,
        hint: supported
          ? `Delivers ${canonical} on BSC (same token, different network).`
          : `${sym} cannot move cross-chain yet — use Convert to USDC first.`,
      })
    }
  }

  items.sort((a, b) => {
    if (a.crossChainReady !== b.crossChainReady) return a.crossChainReady ? -1 : 1
    return (b.usdValue ?? b.balance) - (a.usdValue ?? a.balance)
  })
  return items
}

function roundTokenAmount(n: number, decimals: number): number {
  const factor = 10 ** Math.min(Math.max(decimals, 0), 8)
  return Math.round(n * factor) / factor
}

function computeRouteQuote(
  route: CrossChainRoute,
  amount: number,
  sourceUsdPrice: number,
  destUsdPrice: number,
): CrossChainQuote {
  const usdValue = amount * sourceUsdPrice
  const netUsd = Math.max(0, usdValue - TRANSFER_FEE_USD)
  const creditAmount = destUsdPrice > 0 ? roundTokenAmount(netUsd / destUsdPrice, route.destLeg.decimals) : 0
  return {
    asset: route.sourceSymbol,
    amount,
    feeUsd: TRANSFER_FEE_USD,
    creditAmount,
    minAmount: MIN_TRANSFER_USD,
    maxAmount: MAX_TRANSFER_USD,
    destinationSymbol: route.destSymbol,
    estimated: !route.sameToken,
  }
}

/** Best-effort USD price for the user's source token (wallet-derived, else spot). */
async function priceSourceToken(
  userId: string,
  route: CrossChainRoute,
  sourceAmount: number,
): Promise<number | null> {
  let tokenUsdPrice: number | null = null
  if (route.direction === 'BSC_TO_SOL') {
    const { getPersonalWalletSummary } = await import('./personalWalletService')
    const summary = await getPersonalWalletSummary(userId)
    const row = summary?.balances.find(
      (b) =>
        toCanonicalCrossChainSymbol(b.asset) === route.sourceSymbol ||
        b.asset.toUpperCase() === route.sourceSymbol,
    )
    if (row?.usdPrice) tokenUsdPrice = Number(row.usdPrice)
    else if (row?.usdValue && row.amount > 0) tokenUsdPrice = Number(row.usdValue) / Number(row.amount)
  } else {
    await ensureSolanaPersonalWallet(userId)
    const holdings = await listSolanaHoldings(userId)
    const mint = (route.sourceLeg as CrossChainSolLeg).mint
    const held = holdings.find((h) => h.mint === mint)
    if (held && sourceAmount > 0) {
      const { fetchJupiterPricesV3 } = await import('../dex/jupiterPriceService')
      const prices = await fetchJupiterPricesV3([mint]).catch(() => new Map())
      tokenUsdPrice = mint === SOL_USDC_MINT ? 1 : prices.get(mint)?.usdPrice ?? null
    }
  }
  if (!tokenUsdPrice || tokenUsdPrice <= 0) {
    tokenUsdPrice = await fetchLegUsdPrice(route.sourceLeg.binanceSymbol)
  }
  return tokenUsdPrice
}

export async function previewCrossChainTransfer(
  userId: string,
  params: { direction: CrossChainDirection; amount: number; sourceSymbol?: string; destSymbol?: string },
): Promise<CrossChainTransferPreview> {
  const sourceAmount = Number(params.amount)
  if (!Number.isFinite(sourceAmount) || sourceAmount <= 0) {
    throw new Error('Amount must be positive')
  }

  const route = resolveCrossChainRoute(
    params.direction,
    params.sourceSymbol ?? 'USDC',
    params.destSymbol,
  )

  const sourceUsdPrice = await priceSourceToken(userId, route, sourceAmount)
  if (!sourceUsdPrice || sourceUsdPrice <= 0) {
    throw new Error('Could not price this token for cross-chain quote — try again in a moment.')
  }

  const destUsdPrice = route.sameToken
    ? sourceUsdPrice
    : await fetchLegUsdPrice(route.destLeg.binanceSymbol)
  if (!destUsdPrice || destUsdPrice <= 0) {
    throw new Error(
      `Could not price ${route.destSymbol} right now — try a different destination coin or retry shortly.`,
    )
  }

  const usdValue = sourceAmount * sourceUsdPrice
  if (usdValue < MIN_TRANSFER_USD) {
    throw new Error(`Minimum transfer is about $${MIN_TRANSFER_USD} (your amount ≈ $${usdValue.toFixed(2)}).`)
  }
  if (usdValue > MAX_TRANSFER_USD) {
    throw new Error(`Maximum transfer is about $${MAX_TRANSFER_USD}.`)
  }

  const quote = computeRouteQuote(route, sourceAmount, sourceUsdPrice, destUsdPrice)
  if (quote.creditAmount <= 0) throw new Error('Amount is too small after the settlement fee.')

  return {
    ...quote,
    sourceSymbol: route.sourceSymbol,
    sourceAmount,
    tokenUsdPrice: sourceUsdPrice,
    destTokenUsdPrice: destUsdPrice,
  }
}

export function getCrossChainQuote(amount: number, asset = 'USDC', tokenUsdPrice = 1, decimals = 6): CrossChainQuote {
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 0
  const feeToken = tokenUsdPrice > 0 ? TRANSFER_FEE_USD / tokenUsdPrice : 0
  const creditAmount = safeAmount > 0 ? roundTokenAmount(Math.max(0, safeAmount - feeToken), decimals) : 0
  return {
    asset,
    amount: safeAmount,
    feeUsd: TRANSFER_FEE_USD,
    creditAmount,
    minAmount: MIN_TRANSFER_USD,
    maxAmount: MAX_TRANSFER_USD,
    destinationSymbol: asset,
  }
}

// ---- on-chain leg helpers -------------------------------------------------

async function getMintProgramId(mint: PublicKey): Promise<PublicKey> {
  const info = await conn().getAccountInfo(mint)
  if (info?.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID
  return TOKEN_PROGRAM_ID
}

async function bscTokenBalance(address: string, leg: CrossChainBscLeg): Promise<number> {
  if (leg.native) {
    const raw = await getBscJsonRpcProvider().getBalance(address)
    return Number(formatUnits(raw, 18))
  }
  const token = new Contract(leg.address!, ERC20_ABI, getBscJsonRpcProvider())
  const raw = (await token.balanceOf(address)) as bigint
  return Number(formatUnits(raw, leg.decimals))
}

async function sendBscToken(signer: Wallet, leg: CrossChainBscLeg, to: string, amountHuman: number): Promise<string> {
  if (leg.native) {
    const raw = parseUnits(amountHuman.toString(), 18)
    const bal = await getBscJsonRpcProvider().getBalance(signer.address)
    if (bal < raw) throw new Error(`Insufficient BNB — have ${formatUnits(bal, 18)}, need ${amountHuman}`)
    const resp = (await signer.sendTransaction({ to, value: raw })) as unknown as TransactionResponse
    const receipt = await resp.wait(1)
    if (!receipt || receipt.status !== 1) throw new Error('BNB transfer reverted')
    return resp.hash
  }
  const token = new Contract(leg.address!, ERC20_ABI, signer)
  const raw = parseUnits(amountHuman.toString(), leg.decimals)
  const bal = (await token.balanceOf(signer.address)) as bigint
  if (bal < raw) {
    throw new Error(`Insufficient ${leg.symbol} on BSC — have ${formatUnits(bal, leg.decimals)}, need ${amountHuman}`)
  }
  const resp = (await token.transfer(to, raw)) as unknown as TransactionResponse
  const receipt = await resp.wait(1)
  if (!receipt || receipt.status !== 1) throw new Error(`BSC ${leg.symbol} transfer reverted`)
  return resp.hash
}

async function solTokenBalance(address: string, leg: CrossChainSolLeg): Promise<number> {
  if (leg.native) {
    const lamports = await conn().getBalance(new PublicKey(address))
    return lamports / LAMPORTS_PER_SOL
  }
  const mint = new PublicKey(leg.mint)
  const programId = await getMintProgramId(mint)
  const ata = await getAssociatedTokenAddress(mint, new PublicKey(address), false, programId)
  try {
    const acc = await getAccount(conn(), ata, undefined, programId)
    return Number(acc.amount) / 10 ** leg.decimals
  } catch {
    return 0
  }
}

async function sendSolToken(fromKp: Keypair, leg: CrossChainSolLeg, toAddress: string, amountHuman: number): Promise<string> {
  const c = conn()
  const owner = fromKp.publicKey
  const dest = new PublicKey(toAddress)

  if (leg.native) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: dest,
        lamports: Math.floor(amountHuman * LAMPORTS_PER_SOL),
      }),
    )
    return sendAndConfirmTransaction(c, tx, [fromKp], { commitment: 'confirmed', maxRetries: 3 })
  }

  const mint = new PublicKey(leg.mint)
  const programId = await getMintProgramId(mint)
  const sourceAta = await getAssociatedTokenAddress(mint, owner, false, programId)
  let sourceAmount = 0n
  try {
    sourceAmount = (await getAccount(c, sourceAta, undefined, programId)).amount
  } catch {
    throw new Error(`Source has no ${leg.symbol} token account on Solana`)
  }
  const raw = BigInt(Math.floor(amountHuman * 10 ** leg.decimals))
  if (sourceAmount < raw) throw new Error(`Insufficient ${leg.symbol} on Solana source`)
  const destAta = await getAssociatedTokenAddress(mint, dest, false, programId)
  const tx = new Transaction()
  try {
    await getAccount(c, destAta, undefined, programId)
  } catch {
    tx.add(createAssociatedTokenAccountInstruction(owner, destAta, dest, mint, programId))
  }
  tx.add(createTransferInstruction(sourceAta, destAta, owner, raw, [], programId))
  return sendAndConfirmTransaction(c, tx, [fromKp], { commitment: 'confirmed', maxRetries: 3 })
}

async function bscUsdcBalance(address: string): Promise<number> {
  return bscTokenBalance(address, {
    symbol: 'USDC',
    address: BSC_USDC_ADDRESS,
    decimals: 18,
    native: false,
    binanceSymbol: 'USDCUSDT',
  })
}

async function solUsdcBalance(address: string): Promise<number> {
  return solTokenBalance(address, {
    symbol: 'USDC',
    mint: SOL_USDC_MINT,
    decimals: 6,
    native: false,
    binanceSymbol: 'USDCUSDT',
  })
}

/**
 * Operator bridge wallet must hold native BNB to sign LI.FI bridge txs on BSC.
 * When it is empty but the user still has BNB/WBNB, pull a tiny gas top-up from
 * the user's BSC wallet so pending credits can complete without manual ops funding.
 */
async function topUpOperatorBridgeGasFromUser(
  userBscSigner: Wallet,
  opBscSigner: Wallet,
): Promise<void> {
  const provider = opBscSigner.provider ?? getBscJsonRpcProvider()
  const opBal = await provider.getBalance(opBscSigner.address)
  if (opBal >= MIN_OPERATOR_BNB_FOR_BRIDGE) return

  const deficit = MIN_OPERATOR_BNB_FOR_BRIDGE - opBal + parseEther('0.0002')
  logger.info(
    {
      operator: opBscSigner.address,
      opBnb: formatUnits(opBal, 18),
      topUpBnb: formatUnits(deficit, 18),
    },
    '[cross-chain] topping up operator bridge gas from user BSC wallet',
  )

  await ensureNativeBnbForGas(userBscSigner, deficit + parseEther('0.00015'), 'Your BSC wallet')
  const tx = (await userBscSigner.sendTransaction({
    to: opBscSigner.address,
    value: deficit,
  })) as TransactionResponse
  await tx.wait(1)

  const after = await provider.getBalance(opBscSigner.address)
  if (after < MIN_OPERATOR_BNB_FOR_BRIDGE) {
    throw new Error(
      `Could not fund operator bridge gas — operator still has ${formatUnits(after, 18)} BNB. Add ~0.002 BNB/WBNB to your BSC wallet or send native BNB to ${opBscSigner.address}.`,
    )
  }
}

async function assertOperatorCanSettleCredit(
  route: CrossChainRoute,
  creditAmount: number,
): Promise<void> {
  const opBsc = getHotWalletSigner()
  const opSol = operatorSolanaKeypair()
  if (!opBsc || !opSol) throw new Error('Operator bridge wallets not configured')

  if (route.direction === 'BSC_TO_SOL') {
    // Same-token can settle instantly from operator Solana inventory.
    if (route.sameToken) {
      const opSolBal = await solTokenBalance(opSol.publicKey.toBase58(), route.destLeg as CrossChainSolLeg)
      if (opSolBal >= creditAmount) return
    }
    const nativeBnb = await getBscJsonRpcProvider().getBalance(opBsc.address)
    if (nativeBnb >= MIN_OPERATOR_BNB_FOR_BRIDGE) return
    throw new Error(
      `Cross-chain settlement is not ready yet — operator bridge wallet (${opBsc.address.slice(0, 10)}…) needs ~0.005 native BNB for gas before your transfer starts. Your funds were NOT moved.`,
    )
  }

  if (route.sameToken) {
    const opBscBal = await bscTokenBalance(opBsc.address, route.destLeg as CrossChainBscLeg)
    if (opBscBal >= creditAmount) return
  }
  const lamports = await conn().getBalance(opSol.publicKey)
  if (lamports / LAMPORTS_PER_SOL >= 0.003) return
  throw new Error(
    'Cross-chain settlement is not ready yet — operator Solana bridge wallet needs a little SOL for gas before your transfer starts.',
  )
}

/**
 * Deliver funds to the user's destination wallet.
 *
 * - Same-token: try the operator inventory fast path first (instant), else bridge.
 * - Cross-token: always route through LI.FI, which swaps the source token the
 *   operator just received into the destination token in-flight.
 *
 * `bridgeSourceAmount` is the amount of the SOURCE token to bridge/swap (net of
 * fee); `creditAmount` is the estimated destination-token amount for the fast path.
 */
async function runCreditLeg(
  route: CrossChainRoute,
  bridgeSourceAmount: number,
  creditAmount: number,
  userBscSigner: Wallet,
  userSolKp: Keypair,
  opBscSigner: Wallet,
  opSolKp: Keypair,
): Promise<string> {
  if (route.direction === 'BSC_TO_SOL') {
    const destSol = route.destLeg as CrossChainSolLeg
    if (route.sameToken) {
      const opSolBal = await solTokenBalance(opSolKp.publicKey.toBase58(), destSol)
      if (opSolBal >= creditAmount) {
        logger.info(
          { creditAmount, asset: route.destSymbol },
          '[cross-chain] direct operator Solana credit (pool inventory)',
        )
        return sendSolToken(opSolKp, destSol, userSolKp.publicKey.toBase58(), creditAmount)
      }
    }

    await topUpOperatorBridgeGasFromUser(userBscSigner, opBscSigner)
    await ensureNativeBnbForGas(opBscSigner, MIN_OPERATOR_BNB_FOR_BRIDGE, 'Operator bridge wallet')
    const { bridgeBscToSolanaViaLiFi } = await import('./crossChainBridgeService')
    const bridged = await bridgeBscToSolanaViaLiFi(
      opBscSigner,
      route.sourceLeg as CrossChainBscLeg,
      destSol,
      bridgeSourceAmount,
      userSolKp.publicKey.toBase58(),
    )
    return bridged.destTxHash ?? bridged.sourceTxHash
  }

  const destBsc = route.destLeg as CrossChainBscLeg
  if (route.sameToken) {
    const opBscBal = await bscTokenBalance(opBscSigner.address, destBsc)
    if (opBscBal >= creditAmount) {
      logger.info({ creditAmount, asset: route.destSymbol }, '[cross-chain] direct operator BSC credit (pool inventory)')
      return sendBscToken(opBscSigner, destBsc, userBscSigner.address, creditAmount)
    }
  }

  const { bridgeSolanaToBscViaLiFi } = await import('./crossChainBridgeService')
  const bridged = await bridgeSolanaToBscViaLiFi(
    opSolKp,
    route.sourceLeg as CrossChainSolLeg,
    destBsc,
    bridgeSourceAmount,
    userBscSigner.address,
  )
  return bridged.destTxHash ?? bridged.sourceTxHash
}

/** Amount of the SOURCE token to bridge (gross amount minus fee in source token). */
function computeBridgeSourceAmount(route: CrossChainRoute, amount: number, sourceUsdPrice: number): number {
  const feeToken = sourceUsdPrice > 0 ? TRANSFER_FEE_USD / sourceUsdPrice : 0
  return roundTokenAmount(Math.max(0, amount - feeToken), route.sourceLeg.decimals)
}

/**
 * Deliver the withheld settlement fee (kept in the operator hot wallet on the
 * source chain, in the source token) to the platform fee treasury. Best-effort:
 * a failed sweep never fails the user's transfer — the fee simply stays in the
 * operator wallet until the next successful sweep.
 */
async function sweepTransferFeeToTreasury(
  route: CrossChainRoute,
  feeTokenAmount: number,
  opBscSigner: Wallet,
  opSolKp: Keypair,
  transferId: string,
): Promise<void> {
  if (!(feeTokenAmount > 0)) return
  try {
    let txRef: string
    if (route.sourceChain === 'BSC') {
      txRef = await sendBscToken(opBscSigner, route.sourceLeg as CrossChainBscLeg, feeTreasuryBsc(), feeTokenAmount)
    } else {
      txRef = await sendSolToken(opSolKp, route.sourceLeg as CrossChainSolLeg, feeTreasurySol(), feeTokenAmount)
    }
    logger.info(
      { transferId, feeTokenAmount, asset: route.sourceSymbol, chain: route.sourceChain, txRef },
      '[cross-chain] fee swept to treasury',
    )
  } catch (err) {
    logger.warn(
      { transferId, feeTokenAmount, asset: route.sourceSymbol, chain: route.sourceChain, err },
      '[cross-chain] fee sweep to treasury failed — fee remains in operator wallet',
    )
  }
}

export type CrossChainTransferResult = {
  id: string
  status: CrossChainTransferStatus
  direction: CrossChainDirection
  amount: number
  creditAmount: number
  feeUsd: number
  debitTxRef: string
  creditTxRef: string
}

export async function executeCrossChainTransfer(
  userId: string,
  params: { direction: CrossChainDirection; amount: number; sourceSymbol?: string; destSymbol?: string },
): Promise<CrossChainTransferResult> {
  if (!isCrossChainTransferEnabled()) {
    throw new Error('Cross-chain transfer is not available on this server (operator bridge wallets not configured).')
  }
  const { direction } = params
  if (!CROSS_CHAIN_DIRECTIONS.includes(direction)) throw new Error('Invalid transfer direction')
  const sourceAmount = Number(params.amount)
  if (!Number.isFinite(sourceAmount) || sourceAmount <= 0) throw new Error('Amount must be positive')

  await ensureSolanaPersonalWallet(userId)

  const route = resolveCrossChainRoute(direction, params.sourceSymbol ?? 'USDC', params.destSymbol)
  const preview = await previewCrossChainTransfer(userId, {
    direction,
    amount: sourceAmount,
    sourceSymbol: route.sourceSymbol,
    destSymbol: route.destSymbol,
  })
  const amount = preview.amount
  const quote = preview
  const bridgeSourceAmount = computeBridgeSourceAmount(route, amount, preview.tokenUsdPrice ?? 0)
  if (bridgeSourceAmount <= 0) throw new Error('Amount is too small after the settlement fee.')

  const opBscSigner = getHotWalletSigner()
  const opSolKp = operatorSolanaKeypair()
  if (!opBscSigner || !opSolKp) throw new Error('Operator bridge wallets not configured')

  const userBscSigner = await getPersonalSigner(userId)
  const userSolKp = await getSolanaKeypair(userId)

  if (direction === 'BSC_TO_SOL') {
    await ensureNativeBnbForGas(userBscSigner)
    const userBal = await bscTokenBalance(userBscSigner.address, route.sourceLeg as CrossChainBscLeg)
    if (userBal < amount) {
      throw new Error(`Insufficient ${route.sourceSymbol} on BSC — you have ${userBal.toFixed(6)} but tried ${amount}.`)
    }
  } else {
    const lamports = await conn().getBalance(userSolKp.publicKey)
    if (lamports / LAMPORTS_PER_SOL < 0.003) {
      throw new Error('Your Solana wallet needs a little SOL for gas. Deposit ~0.01 SOL and try again.')
    }
    const userBal = await solTokenBalance(userSolKp.publicKey.toBase58(), route.sourceLeg as CrossChainSolLeg)
    if (userBal < amount) {
      throw new Error(
        `Insufficient ${route.sourceSymbol} on Solana — you have ${userBal.toFixed(6)} but tried ${amount}.`,
      )
    }
  }

  await assertOperatorCanSettleCredit(route, quote.creditAmount)

  const record = await prisma.crossChainTransfer.create({
    data: {
      userId,
      direction,
      asset: route.sourceSymbol,
      destAsset: route.sameToken ? null : route.destSymbol,
      amount,
      feeUsd: quote.feeUsd,
      creditAmount: quote.creditAmount,
      status: CrossChainTransferStatus.PENDING,
    },
  })

  let debitTxRef: string
  try {
    debitTxRef =
      direction === 'BSC_TO_SOL'
        ? await sendBscToken(userBscSigner, route.sourceLeg as CrossChainBscLeg, opBscSigner.address, amount)
        : await sendSolToken(userSolKp, route.sourceLeg as CrossChainSolLeg, opSolKp.publicKey.toBase58(), amount)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Debit failed'
    await prisma.crossChainTransfer.update({
      where: { id: record.id },
      data: { status: CrossChainTransferStatus.FAILED, errorMessage: msg.slice(0, 500), processedAt: new Date() },
    })
    throw new Error(msg)
  }
  await prisma.crossChainTransfer.update({
    where: { id: record.id },
    data: { status: CrossChainTransferStatus.DEBITED, debitTxRef },
  })

  let creditTxRef: string
  try {
    creditTxRef = await runCreditLeg(
      route,
      bridgeSourceAmount,
      quote.creditAmount,
      userBscSigner,
      userSolKp,
      opBscSigner,
      opSolKp,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Credit failed'
    await prisma.crossChainTransfer.update({
      where: { id: record.id },
      data: { status: CrossChainTransferStatus.CREDIT_PENDING, errorMessage: msg.slice(0, 500) },
    })
    logger.error(
      { userId, transferId: record.id, direction, amount, asset: route.sourceSymbol, destAsset: route.destSymbol, debitTxRef, err: msg },
      '[cross-chain] CREDIT FAILED after debit — funds held in operator pool, owed to user',
    )
    throw new Error(
      'Your funds were received on BSC and are safe. Destination delivery will retry automatically once the operator bridge wallet has BNB for gas (~0.005 BNB). No action needed from you.',
    )
  }

  const done = await prisma.crossChainTransfer.update({
    where: { id: record.id },
    data: { status: CrossChainTransferStatus.COMPLETED, creditTxRef, processedAt: new Date() },
  })
  logger.info({ userId, transferId: record.id, direction, amount, asset: route.sourceSymbol, destAsset: route.destSymbol }, '[cross-chain] transfer completed')

  // Deliver the withheld fee to the platform treasury (fire-and-forget).
  void sweepTransferFeeToTreasury(route, amount - bridgeSourceAmount, opBscSigner, opSolKp, record.id)

  return {
    id: done.id,
    status: done.status,
    direction,
    amount,
    creditAmount: quote.creditAmount,
    feeUsd: quote.feeUsd,
    debitTxRef,
    creditTxRef,
  }
}

/** Complete or retry the credit leg for an existing debited transfer. */
export async function executeCrossChainCreditLeg(
  userId: string,
  transferId: string,
): Promise<CrossChainTransferResult> {
  const record = await prisma.crossChainTransfer.findFirst({
    where: { id: transferId, userId },
  })
  if (!record) throw new Error('Transfer not found')
  if (record.status === CrossChainTransferStatus.COMPLETED) {
    return {
      id: record.id,
      status: record.status,
      direction: record.direction as CrossChainDirection,
      amount: Number(record.amount),
      creditAmount: Number(record.creditAmount),
      feeUsd: Number(record.feeUsd),
      debitTxRef: record.debitTxRef ?? '',
      creditTxRef: record.creditTxRef ?? '',
    }
  }
  if (!record.debitTxRef) throw new Error('Transfer has no debit — cannot credit')

  const direction = record.direction as CrossChainDirection
  const route = resolveCrossChainRoute(direction, record.asset, record.destAsset ?? record.asset)
  const opBscSigner = getHotWalletSigner()
  const opSolKp = operatorSolanaKeypair()
  if (!opBscSigner || !opSolKp) throw new Error('Operator bridge wallets not configured')

  const userBscSigner = await getPersonalSigner(userId)
  const userSolKp = await getSolanaKeypair(userId)

  // Recompute the net source amount to bridge from the fresh source price.
  const sourceUsdPrice = (await fetchLegUsdPrice(route.sourceLeg.binanceSymbol)) ?? 0
  const bridgeSourceAmount = computeBridgeSourceAmount(route, Number(record.amount), sourceUsdPrice)
  if (bridgeSourceAmount <= 0) throw new Error('Amount is too small after the settlement fee.')

  let creditTxRef: string
  try {
    creditTxRef = await runCreditLeg(
      route,
      bridgeSourceAmount,
      Number(record.creditAmount),
      userBscSigner,
      userSolKp,
      opBscSigner,
      opSolKp,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Credit failed'
    await prisma.crossChainTransfer.update({
      where: { id: record.id },
      data: { status: CrossChainTransferStatus.CREDIT_PENDING, errorMessage: msg.slice(0, 500) },
    })
    throw new Error(msg)
  }

  const done = await prisma.crossChainTransfer.update({
    where: { id: record.id },
    data: { status: CrossChainTransferStatus.COMPLETED, creditTxRef, processedAt: new Date(), errorMessage: null },
  })
  logger.info({ userId, transferId: record.id, direction, creditTxRef }, '[cross-chain] credit completed (retry)')

  // Deliver the withheld fee to the platform treasury (fire-and-forget).
  void sweepTransferFeeToTreasury(
    route,
    Number(record.amount) - bridgeSourceAmount,
    opBscSigner,
    opSolKp,
    record.id,
  )

  return {
    id: done.id,
    status: done.status,
    direction,
    amount: Number(done.amount),
    creditAmount: Number(done.creditAmount),
    feeUsd: Number(done.feeUsd),
    debitTxRef: done.debitTxRef ?? '',
    creditTxRef,
  }
}

export async function listCrossChainTransfers(userId: string, limit = 20) {
  return prisma.crossChainTransfer.findMany({
    where: { userId },
    orderBy: { requestedAt: 'desc' },
    take: Math.min(50, Math.max(1, limit)),
  })
}
