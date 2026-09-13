/**
 * Cross-chain bridge leg via LI.FI — moves tokens from operator source wallet
 * to the user's destination wallet after the user debit leg completes.
 */
import { Contract, parseUnits, type Wallet } from 'ethers'
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js'
import type { CrossChainBscLeg, CrossChainSolLeg } from '../../lib/crossChainTokenCatalog'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { getHotWalletSigner } from './hotWalletConfig'

const LIFI_API = 'https://li.quest/v1'
const BSC_CHAIN = 56
const SOL_CHAIN = 'SOL'
const NATIVE_EVM = '0x0000000000000000000000000000000000000000'

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]

type LiFiQuote = {
  tool?: string
  transactionRequest?: {
    to?: string
    data?: string
    value?: string
    gasLimit?: string
    chainId?: number
  }
  estimate?: { approvalAddress?: string }
  action?: { fromToken?: { address?: string }; fromAmount?: string }
}

let solConn: Connection | null = null
function conn(): Connection {
  if (!solConn) {
    solConn = new Connection(env.SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com', 'confirmed')
  }
  return solConn
}

function roundForChain(amount: number, decimals: number): number {
  const factor = 10 ** Math.min(Math.max(decimals, 0), 8)
  return Math.round(amount * factor) / factor
}

function toSmallestString(amountHuman: number, decimals: number): string {
  const rounded = roundForChain(amountHuman, decimals)
  const fixed = rounded.toFixed(Math.min(decimals, 12))
  return parseUnits(fixed, decimals).toString()
}

function bscLiFiToken(leg: CrossChainBscLeg): string {
  if (leg.native) return NATIVE_EVM
  return leg.address!
}

function solLiFiToken(leg: CrossChainSolLeg): string {
  return leg.mint
}

async function fetchLiFiQuote(params: URLSearchParams): Promise<LiFiQuote> {
  const res = await fetch(`${LIFI_API}/quote?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(45_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Bridge quote failed (${res.status}): ${body.slice(0, 240)}`)
  }
  return (await res.json()) as LiFiQuote
}

async function ensureEvmAllowance(
  signer: Wallet,
  quote: LiFiQuote,
  fallbackToken: string,
  fallbackAmount: string,
): Promise<void> {
  const approvalAddress = quote.estimate?.approvalAddress
  const fromToken = quote.action?.fromToken?.address ?? fallbackToken
  const spendAmount = quote.action?.fromAmount ?? fallbackAmount
  if (!approvalAddress || fromToken.toLowerCase() === NATIVE_EVM.toLowerCase()) return

  const token = new Contract(fromToken, ERC20_ABI, signer)
  const allowance = (await token.allowance(signer.address, approvalAddress)) as bigint
  if (allowance >= BigInt(spendAmount)) return
  const approveTx = await token.approve(approvalAddress, spendAmount)
  await approveTx.wait(1)
}

async function pollLiFiStatus(
  tool: string | undefined,
  fromChain: string | number,
  toChain: string | number,
  txHash: string,
): Promise<string | undefined> {
  const maxMs = 8 * 60_000
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const params = new URLSearchParams({
      txHash,
      fromChain: String(fromChain),
      toChain: String(toChain),
    })
    if (tool) params.set('bridge', tool)
    const res = await fetch(`${LIFI_API}/status?${params.toString()}`, {
      signal: AbortSignal.timeout(20_000),
    })
    if (res.ok) {
      const data = (await res.json()) as { status?: string; receiving?: { txHash?: string } }
      if (data.status === 'DONE') return data.receiving?.txHash
      if (data.status === 'FAILED') throw new Error('Cross-chain bridge failed on the destination chain')
    }
    await new Promise((r) => setTimeout(r, 4000))
  }
  throw new Error('Bridge is still processing — your transfer will complete shortly')
}

/**
 * Bridge (and optionally swap) from an operator BSC token to any Solana token.
 * When `fromLeg` and `toLeg` are the same asset this is a plain same-token
 * bridge; when they differ, LI.FI performs the cross-token swap in-route.
 */
export async function bridgeBscToSolanaViaLiFi(
  operatorSigner: Wallet,
  fromLeg: CrossChainBscLeg,
  toLeg: CrossChainSolLeg,
  amountHuman: number,
  toSolanaAddress: string,
): Promise<{ sourceTxHash: string; destTxHash?: string }> {
  const fromAmount = toSmallestString(amountHuman, fromLeg.decimals)
  const params = new URLSearchParams({
    fromChain: String(BSC_CHAIN),
    toChain: SOL_CHAIN,
    fromToken: bscLiFiToken(fromLeg),
    toToken: solLiFiToken(toLeg),
    fromAmount,
    fromAddress: operatorSigner.address,
    toAddress: toSolanaAddress,
    slippage: '0.03',
    integrator: 'cryptoflow',
  })

  let quote = await fetchLiFiQuote(params)
  if (!quote.transactionRequest?.to || !quote.transactionRequest.data) {
    throw new Error('Bridge quote did not return a BSC transaction')
  }

  await ensureEvmAllowance(operatorSigner, quote, bscLiFiToken(fromLeg), fromAmount)
  quote = await fetchLiFiQuote(params)

  const txReq = quote.transactionRequest
  if (!txReq?.to || !txReq.data) throw new Error('Bridge quote missing transaction after approval')

  const sent = await operatorSigner.sendTransaction({
    to: txReq.to,
    data: txReq.data,
    value: txReq.value ? BigInt(txReq.value) : 0n,
    gasLimit: txReq.gasLimit ? BigInt(txReq.gasLimit) : undefined,
  })
  const receipt = await sent.wait(1)
  if (!receipt || receipt.status !== 1) throw new Error('Bridge transaction reverted on BSC')

  logger.info(
    { txHash: sent.hash, from: fromLeg.symbol, to: toLeg.symbol, amountHuman, toSolanaAddress },
    '[cross-chain] LI.FI BSC→Solana bridge submitted',
  )

  const destTxHash = await pollLiFiStatus(quote.tool, BSC_CHAIN, SOL_CHAIN, sent.hash)
  return { sourceTxHash: sent.hash, destTxHash }
}

export async function bridgeSolanaToBscViaLiFi(
  operatorKp: Keypair,
  fromLeg: CrossChainSolLeg,
  toLeg: CrossChainBscLeg,
  amountHuman: number,
  toBscAddress: string,
): Promise<{ sourceTxHash: string; destTxHash?: string }> {
  const fromAmount = toSmallestString(amountHuman, fromLeg.decimals)
  const params = new URLSearchParams({
    fromChain: SOL_CHAIN,
    toChain: String(BSC_CHAIN),
    fromToken: solLiFiToken(fromLeg),
    toToken: bscLiFiToken(toLeg),
    fromAmount,
    fromAddress: operatorKp.publicKey.toBase58(),
    toAddress: toBscAddress,
    slippage: '0.03',
    integrator: 'cryptoflow',
  })

  const quote = await fetchLiFiQuote(params)
  const txData = quote.transactionRequest?.data
  if (!txData) throw new Error('Bridge quote did not return a Solana transaction')

  const vtx = VersionedTransaction.deserialize(Buffer.from(txData, 'base64'))
  vtx.sign([operatorKp])
  const sig = await conn().sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 3 })
  await conn().confirmTransaction(sig, 'confirmed')

  logger.info(
    { signature: sig, from: fromLeg.symbol, to: toLeg.symbol, amountHuman, toBscAddress },
    '[cross-chain] LI.FI Solana→BSC bridge submitted',
  )

  const destTxHash = await pollLiFiStatus(quote.tool, SOL_CHAIN, BSC_CHAIN, sig)
  return { sourceTxHash: sig, destTxHash }
}
