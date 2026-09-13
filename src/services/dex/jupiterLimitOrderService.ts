/**
 * Server-side Jupiter limit orders — watches live bid/ask and executes when triggered.
 */
import { randomUUID } from 'crypto'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { isSolanaWalletEnabled } from '../wallet/solanaPersonalWalletService'
import { isJupiterConfigured, isJupiterSwapRateLimited } from './jupiterClassicService'
import { getJupiterExecutableMarks } from './jupiterMarkService'
import { executeJupiterSwap, previewJupiterSwap } from './jupiterSwapService'
import { getSocketIo } from '../../lib/realtimeHub'

export type JupiterLimitOrderSide = 'BUY' | 'SELL'
export type JupiterLimitOrderStatus = 'OPEN' | 'FILLED' | 'CANCELLED'

export type JupiterLimitOrder = {
  id: string
  userId: string
  binanceSymbol: string
  side: JupiterLimitOrderSide
  limitPrice: number
  /** USDC notional for BUY; token qty for SELL */
  amount: number
  spendMint?: string
  status: JupiterLimitOrderStatus
  createdAt: string
  filledAt?: string
  txSignature?: string
}

const ordersByUser = new Map<string, JupiterLimitOrder[]>()

function list(userId: string): JupiterLimitOrder[] {
  return ordersByUser.get(userId) ?? []
}

function save(userId: string, rows: JupiterLimitOrder[]): void {
  ordersByUser.set(userId, rows)
}

export function getJupiterLimitOrders(userId: string): JupiterLimitOrder[] {
  return list(userId).filter((o) => o.status === 'OPEN')
}

export function createJupiterLimitOrder(
  userId: string,
  raw: {
    binanceSymbol: string
    side: JupiterLimitOrderSide
    limitPrice: number
    amount: number
    spendMint?: string
  },
): JupiterLimitOrder {
  const sym = raw.binanceSymbol.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!sym.endsWith('USDT')) throw new Error('binanceSymbol must end with USDT')
  if (!Number.isFinite(raw.limitPrice) || raw.limitPrice <= 0) throw new Error('limitPrice must be positive')
  if (!Number.isFinite(raw.amount) || raw.amount <= 0) throw new Error('amount must be positive')

  const order: JupiterLimitOrder = {
    id: randomUUID(),
    userId,
    binanceSymbol: sym,
    side: raw.side,
    limitPrice: raw.limitPrice,
    amount: raw.amount,
    spendMint: raw.spendMint,
    status: 'OPEN',
    createdAt: new Date().toISOString(),
  }
  const rows = list(userId)
  rows.unshift(order)
  save(userId, rows.slice(0, 40))
  return order
}

export function cancelJupiterLimitOrder(userId: string, orderId: string): boolean {
  const rows = list(userId)
  const idx = rows.findIndex((o) => o.id === orderId && o.status === 'OPEN')
  if (idx < 0) return false
  rows[idx] = { ...rows[idx]!, status: 'CANCELLED' }
  save(userId, rows)
  return true
}

async function tryFillOrder(order: JupiterLimitOrder): Promise<void> {
  const base = order.binanceSymbol.replace(/USDT$/i, '')
  const marks = await getJupiterExecutableMarks(base)
  if (!marks) return

  const triggered =
    order.side === 'BUY'
      ? marks.ask != null && marks.ask <= order.limitPrice
      : marks.bid != null && marks.bid >= order.limitPrice
  if (!triggered) return

  const preview = await previewJupiterSwap(
    {
      side: order.side,
      binanceSymbol: order.binanceSymbol,
      amount: order.amount,
      spendAsset: order.side === 'BUY' && !order.spendMint ? 'USDC' : undefined,
      spendMint: order.side === 'BUY' ? order.spendMint : undefined,
      slippageBps: 150,
    },
    { userId: order.userId },
  )
  if (!preview.tradable || preview.blockTrade) return

  const result = await executeJupiterSwap(order.userId, {
    side: order.side,
    binanceSymbol: order.binanceSymbol,
    amount: order.amount,
    spendAsset: order.side === 'BUY' && !order.spendMint ? 'USDC' : undefined,
    spendMint: order.side === 'BUY' ? order.spendMint : undefined,
    slippageBps: 150,
  })

  const rows = list(order.userId)
  const idx = rows.findIndex((o) => o.id === order.id)
  if (idx < 0) return
  rows[idx] = {
    ...rows[idx]!,
    status: 'FILLED',
    filledAt: new Date().toISOString(),
    txSignature: result.txSignature,
  }
  save(order.userId, rows)

  logger.info(
    { userId: order.userId, orderId: order.id, side: order.side, symbol: order.binanceSymbol },
    '[jupiter-limit] order filled',
  )

  const io = getSocketIo()
  io?.to(`user:${order.userId}`).emit('jupiter:limit-filled', {
    orderId: order.id,
    txSignature: result.txSignature,
  })
}

export async function runJupiterLimitOrderWatcher(): Promise<void> {
  if (!env.dexServerAutoExit || !isSolanaWalletEnabled() || !isJupiterConfigured()) return
  if (isJupiterSwapRateLimited()) return

  for (const [userId, rows] of ordersByUser) {
    const open = rows.filter((o) => o.status === 'OPEN')
    for (const order of open) {
      try {
        await tryFillOrder(order)
      } catch (err) {
        logger.warn({ err, userId, orderId: order.id }, '[jupiter-limit] fill failed')
      }
    }
  }
}

export function startJupiterLimitOrderWatcher(): void {
  if (!env.dexServerAutoExit) return
  logger.info('[jupiter-limit] watcher started (8s interval)')
  void runJupiterLimitOrderWatcher()
  setInterval(() => void runJupiterLimitOrderWatcher(), 8_000)
}
