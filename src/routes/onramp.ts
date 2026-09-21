/**
 * Fiat on-ramp / off-ramp session builder.
 *
 * Funds land either in the user's Godslandx personal wallet or in a wallet the
 * user has connected in their browser, whichever they pick. Providers are
 * Transak and MoonPay; KYC and settlement stay with them.
 *
 * Every session is recorded as a FiatRampOrder before the widget opens, keyed by
 * a partner order id, so provider webhooks can be matched back and a user who
 * closes the provider tab can still see what happened.
 */
import { Router, Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { prisma } from '@cryptoflow/db'
import { authenticateToken } from '../middleware/authenticateToken'
import { asyncHandler } from '../middleware/asyncHandler'
import { validate } from '../middleware/validate'
import { logger } from '../lib/logger'
import { ensurePersonalWallet, getPersonalWalletSummary } from '../services/wallet/personalWalletService'
import {
  ensureSolanaPersonalWallet,
  getSolanaWalletStatus,
  isSolanaWalletEnabled,
} from '../services/wallet/solanaPersonalWalletService'
import { env } from '../lib/env'

const router = Router()

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/

const sessionBody = z.object({
  direction: z.enum(['buy', 'sell']).default('buy'),
  chain: z.enum(['bsc', 'solana']).default('bsc'),
  fiat: z.string().min(3).max(8).default('INR'),
  crypto: z.string().min(2).max(12).default('USDT'),
  provider: z.enum(['transak', 'moonpay', 'auto']).default('auto'),
  /** Fiat to spend when buying. */
  fiatAmount: z.number().positive().max(1_000_000).optional(),
  /** Crypto to sell when cashing out. */
  cryptoAmount: z.number().positive().max(1_000_000_000).optional(),
  /**
   * Where the crypto should land. 'browser' routes to a self-custody address
   * the user supplies, which never touches our keys.
   */
  walletSource: z.enum(['platform', 'browser']).default('platform'),
  browserAddress: z.string().min(32).max(64).optional(),
})

function transakKey(): string {
  return process.env.TRANSAK_API_KEY?.trim() || process.env.NEXT_PUBLIC_TRANSAK_API_KEY?.trim() || ''
}

function moonpayKey(): string {
  return process.env.MOONPAY_API_KEY?.trim() || process.env.NEXT_PUBLIC_MOONPAY_API_KEY?.trim() || ''
}

router.get(
  '/status',
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const clientIp =
      (typeof req.headers['x-forwarded-for'] === 'string'
        ? req.headers['x-forwarded-for'].split(',')[0]?.trim()
        : undefined) ||
      req.socket.remoteAddress ||
      '127.0.0.1'
    const transakSessionReady = transakKey() ? await transakGatewayAuthorized(clientIp) : false
    res.json({
      providers: {
        transak: {
          configured: Boolean(transakKey()),
          sessionReady: transakSessionReady,
          kyc: 'provider',
        },
        moonpay: { configured: Boolean(moonpayKey()), kyc: 'provider' },
      },
      transakSetup: transakSessionReady
        ? null
        : {
            serverIp: '157.245.100.175',
            domain: 'trade.godslandx.com',
            message:
              'Transak must whitelist our server IP and domain before checkout works. Email support.transak.com — usually sorted in 1–2 business days.',
          },
      supportedFiat: ['INR', 'AED', 'USD', 'EUR', 'GBP', 'AUD', 'SGD'],
      supportedCrypto: {
        bsc: ['USDT', 'USDC', 'BNB'],
        solana: ['USDC', 'SOL'],
      },
      note:
        'Fiat rails run through licensed partners (Transak / MoonPay). Godslandx never holds your bank details — KYC is completed inside the checkout below.',
    })
  }),
)

/** Recent ramp attempts so the user can see status without the provider tab. */
router.get(
  '/orders',
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20))
    const rows = await prisma.fiatRampOrder.findMany({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    res.json({
      orders: rows.map((r) => ({
        id: r.id,
        partnerOrderId: r.partnerOrderId,
        provider: r.provider,
        direction: r.direction,
        chain: r.chain,
        fiatCurrency: r.fiatCurrency,
        cryptoCurrency: r.cryptoCurrency,
        fiatAmount: r.fiatAmount != null ? Number(r.fiatAmount) : null,
        cryptoAmount: r.cryptoAmount != null ? Number(r.cryptoAmount) : null,
        walletAddress: r.walletAddress,
        walletSource: r.walletSource,
        status: r.status,
        txHash: r.txHash,
        failureReason: r.failureReason,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    })
  }),
)

router.post(
  '/session',
  authenticateToken,
  validate(sessionBody),
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req as Request & { validated: z.infer<typeof sessionBody> }).validated
    const userId = req.user!.userId
    const appUrl = (env.FRONTEND_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://trade.godslandx.com').replace(
      /\/$/,
      '',
    )

    let walletAddress: string
    if (body.walletSource === 'browser') {
      const addr = body.browserAddress?.trim() ?? ''
      const valid = body.chain === 'solana' ? SOLANA_ADDRESS.test(addr) : EVM_ADDRESS.test(addr)
      if (!valid) {
        res.status(400).json({
          error:
            body.chain === 'solana'
              ? 'Connect a Solana wallet first — the address does not look like a Solana account.'
              : 'Connect an EVM wallet first — the address does not look like a BSC account.',
        })
        return
      }
      walletAddress = addr
    } else if (body.chain === 'solana') {
      if (!isSolanaWalletEnabled()) {
        res.status(503).json({ error: 'Solana wallet not configured' })
        return
      }
      await ensureSolanaPersonalWallet(userId)
      const st = await getSolanaWalletStatus(userId)
      walletAddress = st.wallet?.address ?? ''
    } else {
      await ensurePersonalWallet(userId)
      const st = await getPersonalWalletSummary(userId)
      walletAddress = st?.address ?? ''
    }
    if (!walletAddress) {
      res.status(400).json({ error: 'Could not resolve a destination wallet address' })
      return
    }

    const fiat = body.fiat.toUpperCase()
    const crypto = body.crypto.toUpperCase()
    const network = body.chain === 'solana' ? 'solana' : 'bsc'

    let provider = body.provider
    if (provider === 'auto') {
      provider = transakKey() ? 'transak' : moonpayKey() ? 'moonpay' : 'transak'
    }

    // Recorded before the widget opens so a webhook can never arrive first.
    const partnerOrderId = `gdx_${randomUUID()}`
    await prisma.fiatRampOrder.create({
      data: {
        userId,
        partnerOrderId,
        provider,
        direction: body.direction,
        chain: body.chain,
        fiatCurrency: fiat,
        cryptoCurrency: crypto,
        fiatAmount: body.fiatAmount ?? null,
        cryptoAmount: body.cryptoAmount ?? null,
        walletAddress,
        walletSource: body.walletSource,
        status: 'created',
      },
    })

    const redirectURL = `${appUrl}/onramp?order=${partnerOrderId}`

    let url: string
    let configured: boolean
    let compliance: string

    if (provider === 'transak') {
      // Query-string widget URLs are deprecated — Transak production now
      // requires a short-lived sessionId from Create Widget URL.
      const widgetParams: Record<string, string | number | boolean> = {
        apiKey: transakKey() || 'PUBLISHABLE_KEY_REQUIRED',
        referrerDomain: 'trade.godslandx.com',
        walletAddress,
        cryptoCurrencyCode: crypto,
        network,
        fiatCurrency: fiat,
        productsAvailed: body.direction === 'buy' ? 'BUY' : 'SELL',
        redirectURL,
        partnerOrderId,
        partnerCustomerId: userId,
        themeColor: '7c3aed',
        disableWalletAddressForm: body.walletSource === 'platform',
      }
      if (body.direction === 'buy' && body.fiatAmount != null) {
        widgetParams.fiatAmount = body.fiatAmount
      }
      if (body.direction === 'sell' && body.cryptoAmount != null) {
        widgetParams.cryptoAmount = body.cryptoAmount
      }

      const clientIp =
        (typeof req.headers['x-forwarded-for'] === 'string'
          ? req.headers['x-forwarded-for'].split(',')[0]?.trim()
          : undefined) ||
        req.socket.remoteAddress ||
        '127.0.0.1'

      const secure = await createTransakWidgetUrl(widgetParams, clientIp)
      if (!secure) {
        await prisma.fiatRampOrder.update({
          where: { partnerOrderId },
          data: { status: 'failed', failureReason: 'Transak session not enabled for this server yet' },
        })
        res.status(502).json({
          error:
            'Transak checkout is not enabled for our server yet. This is a one-time Transak setup step — not your fault.',
          setupRequired: true,
          transakSetup: {
            serverIp: '157.245.100.175',
            domain: 'trade.godslandx.com',
            steps: [
              'Email Transak support (support.transak.com) and ask them to whitelist server IP 157.245.100.175 for Create Widget URL API.',
              'Ask them to whitelist domain trade.godslandx.com (must match referrerDomain exactly).',
              'In Transak dashboard → Products, confirm Sell (off-ramp) is enabled for Production.',
              'Complete KYB at forms.transak.com/kyb if not done yet — production widget sessions need it.',
            ],
          },
        })
        return
      }
      url = secure
      configured = Boolean(transakKey())
      compliance =
        body.direction === 'buy'
          ? 'KYC stays inside the checkout below (run by Transak). Crypto lands on the destination address above.'
          : 'KYC stays inside the checkout below. Transak shows a deposit address — send crypto there, then fiat goes to your bank.'
    } else {
      const isProd = process.env.MOONPAY_ENV === 'production'
      const buyBase = isProd ? 'https://buy.moonpay.com' : 'https://buy-sandbox.moonpay.com'
      const sellBase = isProd ? 'https://sell.moonpay.com' : 'https://sell-sandbox.moonpay.com'
      const params = new URLSearchParams({
        apiKey: moonpayKey() || 'PUBLISHABLE_KEY_REQUIRED',
        walletAddress,
        // MoonPay namespaces multi-chain assets, e.g. usdt on BSC is usdt_bsc.
        currencyCode:
          crypto === 'USDT' && body.chain === 'bsc'
            ? 'usdt_bsc'
            : crypto === 'USDC' && body.chain === 'solana'
              ? 'usdc_sol'
              : crypto.toLowerCase(),
        baseCurrencyCode: fiat.toLowerCase(),
        redirectURL,
        externalTransactionId: partnerOrderId,
        externalCustomerId: userId,
        colorCode: '#7c3aed',
      })
      if (body.direction === 'buy' && body.fiatAmount != null) {
        params.set('baseCurrencyAmount', String(body.fiatAmount))
      }
      if (body.direction === 'sell' && body.cryptoAmount != null) {
        params.set('quoteCurrencyAmount', String(body.cryptoAmount))
      }
      url = `${body.direction === 'sell' ? sellBase : buyBase}?${params.toString()}`
      configured = Boolean(moonpayKey())
      compliance =
        body.direction === 'buy'
          ? 'MoonPay handles KYC/AML and delivers the crypto to the destination address above.'
          : 'MoonPay handles KYC/AML. Sells settle from the wallet you send from to your bank account.'
    }

    res.json({
      provider,
      walletAddress,
      walletSource: body.walletSource,
      chain: body.chain,
      partnerOrderId,
      url,
      configured,
      compliance,
    })
  }),
)

/** Provider status values mapped onto ours, so the UI has a small fixed set. */
function mapStatus(raw: string): 'created' | 'pending' | 'completed' | 'failed' {
  const s = raw.toUpperCase()
  if (/COMPLETE|SUCCESS/.test(s)) return 'completed'
  if (/FAIL|CANCEL|EXPIRED|REFUND|DECLIN/.test(s)) return 'failed'
  if (/PENDING|PROCESSING|SUBMITTED|AWAITING|ONGOING|PAYMENT/.test(s)) return 'pending'
  return 'created'
}

/**
 * Transak signs webhooks as a JWT in the `data` field, using the Partner Access
 * Token as the HS256 secret. That token is itself minted from the API key and
 * secret and expires after seven days, so it is fetched on demand and cached
 * until just before it lapses.
 */
let cachedAccessToken: { token: string; expiresAtMs: number } | null = null
let cachedGatewayProbe: { at: number; ok: boolean } | null = null
const GATEWAY_PROBE_TTL_MS = 5 * 60_000

async function transakGatewayAuthorized(userIp: string): Promise<boolean> {
  const now = Date.now()
  if (cachedGatewayProbe && now - cachedGatewayProbe.at < GATEWAY_PROBE_TTL_MS) {
    return cachedGatewayProbe.ok
  }
  const apiKey = transakKey()
  const accessToken = await transakAccessToken()
  if (!apiKey || !accessToken) {
    cachedGatewayProbe = { at: now, ok: false }
    return false
  }
  const isProd = process.env.TRANSAK_ENV === 'production'
  const gateway = isProd ? 'https://api-gateway.transak.com' : 'https://api-gateway-stg.transak.com'
  try {
    const resp = await fetch(`${gateway}/api/v2/auth/session`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'access-token': accessToken,
        'x-api-key': apiKey,
        'x-user-ip': userIp.replace(/^::ffff:/, ''),
      },
      body: JSON.stringify({
        widgetParams: { apiKey, referrerDomain: 'trade.godslandx.com' },
      }),
    })
    const ok = resp.ok
    cachedGatewayProbe = { at: now, ok }
    return ok
  } catch {
    cachedGatewayProbe = { at: now, ok: false }
    return false
  }
}

async function transakAccessToken(): Promise<string | null> {
  const apiKey = transakKey()
  const apiSecret = process.env.TRANSAK_API_SECRET?.trim()
  if (!apiKey || !apiSecret) return null

  if (cachedAccessToken && cachedAccessToken.expiresAtMs > Date.now() + 60_000) {
    return cachedAccessToken.token
  }

  const base =
    process.env.TRANSAK_ENV === 'production' ? 'https://api.transak.com' : 'https://api-stg.transak.com'
  try {
    const resp = await fetch(`${base}/partners/api/v2/refresh-token`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'api-secret': apiSecret,
      },
      body: JSON.stringify({ apiKey }),
    })
    if (!resp.ok) {
      logger.warn({ status: resp.status }, '[onramp] transak refresh-token failed')
      return null
    }
    const body = (await resp.json()) as { data?: { accessToken?: string; expiresAt?: number } }
    const token = body.data?.accessToken
    if (!token) return null
    const expiresAtMs = body.data?.expiresAt != null ? body.data.expiresAt * 1000 : Date.now() + 6 * 86_400_000
    cachedAccessToken = { token, expiresAtMs }
    return token
  } catch (err) {
    logger.warn({ err }, '[onramp] could not mint transak access token')
    return null
  }
}

/**
 * Production Transak widgets must be opened via a sessionId minted here.
 * Passing query params straight to global.transak.com is deprecated and
 * fails with a generic "Something went wrong" page.
 */
async function createTransakWidgetUrl(
  widgetParams: Record<string, string | number | boolean>,
  userIp: string,
): Promise<string | null> {
  const apiKey = transakKey()
  const accessToken = await transakAccessToken()
  if (!apiKey || !accessToken) {
    logger.warn('[onramp] cannot create Transak widget — missing API key or access token')
    return null
  }

  const isProd = process.env.TRANSAK_ENV === 'production'
  const gateway = isProd ? 'https://api-gateway.transak.com' : 'https://api-gateway-stg.transak.com'

  try {
    const resp = await fetch(`${gateway}/api/v2/auth/session`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'access-token': accessToken,
        'x-api-key': apiKey,
        'x-user-ip': userIp.replace(/^::ffff:/, ''),
      },
      body: JSON.stringify({ widgetParams }),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      logger.warn({ status: resp.status, text: text.slice(0, 400) }, '[onramp] create widget URL failed')
      return null
    }
    const body = (await resp.json()) as { data?: { widgetUrl?: string } }
    return body.data?.widgetUrl ?? null
  } catch (err) {
    logger.warn({ err }, '[onramp] create widget URL threw')
    return null
  }
}

/**
 * Transak webhook. Unauthenticated by design — the provider calls it — so the
 * JWT signature is verified before anything is written.
 */
router.post(
  '/webhook/transak',
  asyncHandler(async (req: Request, res: Response) => {
    const accessToken = await transakAccessToken()
    if (!accessToken) {
      res.status(503).json({ error: 'Webhook not configured' })
      return
    }

    const signed = (req.body as { data?: unknown } | undefined)?.data
    if (typeof signed !== 'string' || signed.length === 0) {
      res.status(400).json({ error: 'Missing signed payload' })
      return
    }

    let claims: Record<string, unknown>
    try {
      claims = jwt.verify(signed, accessToken, { algorithms: ['HS256'] }) as Record<string, unknown>
    } catch {
      logger.warn('[onramp] rejected transak webhook with an invalid signature')
      res.status(401).json({ error: 'Bad signature' })
      return
    }

    const data = (claims.webhookData ?? claims) as Record<string, unknown>
    const partnerOrderId = String(data.partnerOrderId ?? '').trim()
    if (!partnerOrderId) {
      res.status(400).json({ error: 'Missing partnerOrderId' })
      return
    }

    const status = mapStatus(String(data.status ?? claims.eventID ?? ''))
    await prisma.fiatRampOrder
      .update({
        where: { partnerOrderId },
        data: {
          status,
          providerOrderId: data.id != null ? String(data.id) : undefined,
          txHash: data.transactionHash != null ? String(data.transactionHash) : undefined,
          cryptoAmount:
            data.cryptoAmount != null && Number.isFinite(Number(data.cryptoAmount))
              ? Number(data.cryptoAmount)
              : undefined,
          failureReason: status === 'failed' ? String(data.statusReason ?? 'Provider reported failure') : null,
        },
      })
      .catch((err: unknown) => {
        // An unknown id is not worth retrying, so acknowledge and move on.
        logger.warn({ err, partnerOrderId }, '[onramp] transak webhook for unknown order')
      })

    res.json({ ok: true })
  }),
)

export default router
