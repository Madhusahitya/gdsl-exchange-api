import { Router, Request, Response } from 'express'
import { prisma } from '@cryptoflow/db'
import { authenticateToken } from '../middleware/authenticateToken'
import { validate } from '../middleware/validate'
import { asyncHandler } from '../middleware/asyncHandler'
import { createExchangeConnectionSchema } from '../validators'
import { encryptSecret, decryptSecret } from '../lib/crypto'
import { binanceAdapter } from '../services/exchange/binanceAdapter'
import {
  getBinancePermissionState,
  sanitizeBinanceCredential,
} from '../services/exchange/binancePermissions'
import { binanceSpotAdapter } from '../services/exchange/binanceSpotAdapter'
import {
  freeAsset,
  sumQuoteStables,
  topNonZeroBalances,
} from '../services/exchange/binanceBalanceHelpers'

const router = Router()

/**
 * IPv4 (or IPv6) seen by the public internet from **this API process**.
 * Use this value in Binance → API Management → IP access restrictions.
 * (Localhost is only your browser; Binance always sees the machine running Node.)
 */
router.get(
  '/outbound-ip',
  authenticateToken,
  asyncHandler(async (_req: Request, res: Response) => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 10_000)
    try {
      const r = await fetch('https://api.ipify.org?format=json', { signal: ctrl.signal })
      const j = (await r.json()) as { ip?: string }
      const ip = typeof j.ip === 'string' ? j.ip : null
      res.json({
        ip,
        source: 'api.ipify.org',
        note:
          'Add this address to your Binance API key IP whitelist (if enabled). Requests are made from the host that runs apps/api — same IP for all Binance calls from this server.',
      })
    } catch (e) {
      res.status(502).json({
        ip: null,
        error: 'Could not resolve outbound IP',
        detail: e instanceof Error ? e.message : String(e),
      })
    } finally {
      clearTimeout(t)
    }
  })
)

router.post('/connections', authenticateToken, validate(createExchangeConnectionSchema), asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const { exchange, label, apiKey: rawKey, apiSecret: rawSecret } = (req as Request & {
    validated: { exchange: 'BINANCE'; label?: string; apiKey: string; apiSecret: string }
  }).validated
  const apiKey = sanitizeBinanceCredential(rawKey)
  const apiSecret = sanitizeBinanceCredential(rawSecret)

  let account: unknown
  try {
    account = await binanceAdapter.testConnection(apiKey, apiSecret)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    res.status(400).json({
      error:
        'Binance rejected the key (wrong secret, IP not whitelisted, disabled key, or mainnet vs testnet mismatch). Fix it in Binance API Management — details below.',
      detail,
    })
    return
  }

  const permissionState = getBinancePermissionState(account)
  if (!permissionState.canTrade) {
    res.status(400).json({
      error: 'This Binance key does not have trading permission enabled.',
      detail: 'Enable Spot trading for this key in Binance API Management, then reconnect.',
      permissions: permissionState.permissions,
    })
    return
  }
  if (permissionState.canWithdraw) {
    res.status(400).json({
      error: 'Withdraw permission is not allowed for automated non-custodial trading.',
      detail:
        'This API key itself has withdraw enabled in Binance API Management. Turn off Enable Withdrawals, then reconnect. (Account-level withdraw via the website is fine.)',
      permissions: permissionState.permissions,
    })
    return
  }

  const connection = await prisma.exchangeConnection.upsert({
    where: { userId_exchange: { userId, exchange } },
    create: {
      userId,
      exchange,
      label,
      encryptedApiKey: encryptSecret(apiKey),
      encryptedSecret: encryptSecret(apiSecret),
      canTrade: permissionState.canTrade,
      canRead: permissionState.canRead,
      canWithdraw: permissionState.canWithdraw,
      isActive: true,
      lastCheckedAt: new Date(),
    },
    update: {
      label,
      encryptedApiKey: encryptSecret(apiKey),
      encryptedSecret: encryptSecret(apiSecret),
      canTrade: permissionState.canTrade,
      canRead: permissionState.canRead,
      canWithdraw: permissionState.canWithdraw,
      isActive: true,
      lastCheckedAt: new Date(),
    },
  })

  res.status(201).json({
    id: connection.id,
    exchange: connection.exchange,
    canTrade: connection.canTrade,
    canRead: connection.canRead,
    canWithdraw: connection.canWithdraw,
    permissions: permissionState.permissions,
  })
}))

router.get('/connections', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const connections = await prisma.exchangeConnection.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      exchange: true,
      label: true,
      canTrade: true,
      canRead: true,
      canWithdraw: true,
      isActive: true,
      lastCheckedAt: true,
      createdAt: true,
    },
  })
  res.json(connections)
}))

router.get('/balances', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const baseAsset =
    typeof req.query.base === 'string' && req.query.base.trim()
      ? req.query.base.trim().toUpperCase()
      : 'BTC'

  const conn = await prisma.exchangeConnection.findFirst({
    where: { userId, isActive: true, canTrade: true, canWithdraw: false, exchange: 'BINANCE' },
    orderBy: { updatedAt: 'desc' },
  })

  if (!conn) {
    res.json({
      connected: false,
      connectionId: null,
      label: null,
      quoteTotalUsd: 0,
      freeUsdt: 0,
      freeUsdc: 0,
      freeBase: 0,
      baseAsset,
      assets: [],
      error: 'Connect your Binance API key first.',
      updatedAt: new Date().toISOString(),
    })
    return
  }

  try {
    const rows = await binanceSpotAdapter.getBalances(
      decryptSecret(conn.encryptedApiKey),
      decryptSecret(conn.encryptedSecret),
    )
    res.json({
      connected: true,
      connectionId: conn.id,
      label: conn.label,
      quoteTotalUsd: sumQuoteStables(rows),
      freeUsdt: freeAsset(rows, 'USDT'),
      freeUsdc: freeAsset(rows, 'USDC'),
      freeBase: freeAsset(rows, baseAsset),
      baseAsset,
      assets: topNonZeroBalances(rows),
      error: null,
      updatedAt: new Date().toISOString(),
    })
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    res.json({
      connected: true,
      connectionId: conn.id,
      label: conn.label,
      quoteTotalUsd: 0,
      freeUsdt: 0,
      freeUsdc: 0,
      freeBase: 0,
      baseAsset,
      assets: [],
      error: detail,
      updatedAt: new Date().toISOString(),
    })
  }
}))

router.post('/connections/:id/test', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const id = String(req.params.id)
  const connection = await prisma.exchangeConnection.findFirst({ where: { id, userId } })
  if (!connection) {
    res.status(404).json({ error: 'Connection not found' })
    return
  }
  const account = await binanceAdapter.testConnection(decryptSecret(connection.encryptedApiKey), decryptSecret(connection.encryptedSecret))
  const permissionState = getBinancePermissionState(account)
  if (permissionState.canWithdraw) {
    res.status(400).json({
      error: 'This key still has withdraw permission enabled.',
      detail:
        'Turn off Enable Withdrawals on this API key in Binance (not account withdraw). Trade-only keys are required.',
      permissions: permissionState.permissions,
    })
    return
  }
  if (!permissionState.canTrade) {
    res.status(400).json({
      error: 'Trading permission is not enabled on this key.',
      detail: 'Enable Spot trading in Binance API Management, then test again.',
      permissions: permissionState.permissions,
    })
    return
  }
  await prisma.exchangeConnection.update({
    where: { id: connection.id },
    data: {
      lastCheckedAt: new Date(),
      canTrade: permissionState.canTrade,
      canRead: permissionState.canRead,
      canWithdraw: permissionState.canWithdraw,
    },
  })
  res.json({
    ok: true,
    canTrade: permissionState.canTrade,
    canRead: permissionState.canRead,
    canWithdraw: permissionState.canWithdraw,
    permissions: permissionState.permissions,
  })
}))

router.delete('/connections/:id', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const id = String(req.params.id)
  await prisma.exchangeConnection.updateMany({ where: { id, userId }, data: { isActive: false } })
  res.json({ ok: true })
}))

export default router
