import { Router, Request, Response } from 'express'
import { prisma, ExecutionEventType } from '@cryptoflow/db'
import {
  appendTradingLog,
  computeAISignal,
  fetchBookTicker,
  getLastEngineSignal,
} from '@cryptoflow/bot'
import { decryptSecret } from '../lib/crypto'
import { binanceSpotAdapter } from '../services/exchange/binanceSpotAdapter'
import { getCexExitSettings, setCexExitSettings } from '../services/exchange/cexExitSettingsService'
import {
  getCexSuperMachineSettings,
  getCexSuperMachineStatus,
  setCexSuperMachineSettings,
  setCexPositionExitOverrides,
  skimCexPositionProfit,
} from '../services/agents/cexSuperMachineService'
import {
  getRecentCexCouncilDecisions,
  getCexCouncilStatus,
} from '../services/agents/cexCouncilService'
import { liveTradingBot } from '../services/bot/liveTradingBot'
import { env } from '../lib/env'
import { z } from 'zod'
import { authenticateToken } from '../middleware/authenticateToken'
import { validate } from '../middleware/validate'
import { asyncHandler } from '../middleware/asyncHandler'
import { engineStartSchema, webhookSchema } from '../validators'
import { listTradingLogs } from '../logging/tradingLogService'
import { getOpenPositionsForUser } from '../positions/positionService'
import { fetchBnbUsdtPrice, fetchBscGasGwei, fetchFearGreed } from '../services/freeMarketApis'
import { computeAutomationReadiness } from '../services/risk/readiness'
import {
  computeEnhancedSignalSnapshot,
  computeMultiSymbolSnapshot,
} from '../services/signals/providersHub'
import { evaluateTradeIntent } from '../services/signals/tradeAdvisor'
import { orderBookService } from '../services/market/orderBook'
import { getBinanceUsdtMarketBoard } from '../services/trading/binanceMarketBoard'
import { getMarketContext } from '../services/market/marketContextService'
import { klineService } from '../services/market/klineService'
import {
  executeManualTrade,
  getManualDesk,
  previewManualTrade,
} from '../services/trading/cexManualTradingService'

const router = Router()

router.post(
  '/webhook',
  validate(webhookSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const secret = process.env.TRADINGVIEW_WEBHOOK_SECRET
    if (!secret && process.env.NODE_ENV === 'production') {
      res.status(503).json({ error: 'Webhook disabled: TRADINGVIEW_WEBHOOK_SECRET not set.' })
      return
    }
    if (secret) {
      const hdr = req.headers['x-webhook-secret']
      if (hdr !== secret) {
        res.status(401).json({ error: 'Invalid webhook secret' })
        return
      }
    }

    const body = (req as Request & { validated: Record<string, unknown> }).validated

    const pickStr = (o: Record<string, unknown>, k: string): string | undefined => {
      const v = o[k]
      if (typeof v === 'string') return v
      if (typeof v === 'number' && Number.isFinite(v)) return String(v)
      return undefined
    }

    const symbol =
      pickStr(body, 'symbol') ?? pickStr(body, 'ticker') ?? pickStr(body, 'pair')
    const action =
      pickStr(body, 'action') ?? pickStr(body, 'signal') ?? pickStr(body, 'side')
    const userId = pickStr(body, 'userId')

    const msg = `TradingView webhook: ${symbol ?? '?'} ${action ?? ''}`
    if (userId) {
      let meta: Record<string, unknown> = { symbol, action }
      try {
        const raw = JSON.stringify(body)
        meta =
          raw.length > 8000
            ? { ...meta, payloadTruncated: raw.slice(0, 7900) + '…' }
            : { ...meta, payload: body }
      } catch {
        meta = { symbol, action }
      }
      await appendTradingLog(userId, 'WEBHOOK', msg, meta)
    }

    res.status(202).json({ received: true, message: msg })
  })
)

router.use(authenticateToken)

router.get(
  '/signal',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const s = getLastEngineSignal(userId)
    res.json({
      signal: s?.action ?? 'HOLD',
      confidence: s?.confidence ?? 0,
      minConfidenceRequired: s?.minConfidenceRequired ?? null,
      features: s?.features ?? null,
      updatedAt: s?.updatedAt ?? null,
    })
  })
)

type OpenSignal = 'BUY' | 'SELL' | 'HOLD'
/** Technical (Binance klines) alone is enough; Fear&Greed is optional so a single upstream failure does not block live trading. */
const MIN_SIGNAL_PROVIDER_COUNT = 1
const MIN_SIGNAL_CONSENSUS_CONFIDENCE = 0.2
const MAX_SIGNAL_AGE_MS = 3 * 60 * 1000

type OpenSignalProvider = {
  id: string
  name: string
  sourceUrl: string
  signal: OpenSignal
  confidence: number
  note?: string
  features?: Record<string, unknown> | null
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

function computeConsensus(providers: OpenSignalProvider[]): {
  signal: OpenSignal
  confidence: number
  counts: { buy: number; sell: number; hold: number }
} {
  if (providers.length === 0) {
    return { signal: 'HOLD', confidence: 0, counts: { buy: 0, sell: 0, hold: 0 } }
  }

  const weighted = { BUY: 0, SELL: 0, HOLD: 0 }
  const counts = { buy: 0, sell: 0, hold: 0 }
  for (const p of providers) {
    const w = clamp01(p.confidence)
    weighted[p.signal] += w
    if (p.signal === 'BUY') counts.buy += 1
    else if (p.signal === 'SELL') counts.sell += 1
    else counts.hold += 1
  }

  const max = Math.max(weighted.BUY, weighted.SELL, weighted.HOLD)
  const winners = ([
    ['BUY', weighted.BUY],
    ['SELL', weighted.SELL],
    ['HOLD', weighted.HOLD],
  ] as const).filter(([, score]) => score === max)

  if (winners.length !== 1) {
    return { signal: 'HOLD', confidence: clamp01(max / providers.length), counts }
  }

  return {
    signal: winners[0][0],
    confidence: clamp01(max / providers.length),
    counts,
  }
}

async function computeOpenSignalSnapshot(symbol: string) {
    const providers: OpenSignalProvider[] = []
    const [technical, fearGreed] = await Promise.all([computeAISignal(symbol), fetchFearGreed()])

    if (technical) {
      providers.push({
        id: 'binance-technical',
        name: 'Binance public klines (EMA/RSI/ATR)',
        sourceUrl: 'https://api.binance.com/api/v3/klines',
        signal: technical.action,
        confidence: clamp01(technical.confidence),
        features: technical.features ?? null,
      })
    }

    if (fearGreed) {
      let signal: OpenSignal = 'HOLD'
      if (fearGreed.value <= 30) signal = 'BUY'
      else if (fearGreed.value >= 70) signal = 'SELL'
      const confidence = clamp01(Math.abs(fearGreed.value - 50) / 50)
      providers.push({
        id: 'alternative-me-fng',
        name: 'Alternative.me Fear & Greed',
        sourceUrl: 'https://api.alternative.me/fng/',
        signal,
        confidence,
        note: fearGreed.classification,
        features: {
          value: fearGreed.value,
          classification: fearGreed.classification,
        },
      })
    }

  const updatedAt = new Date().toISOString()
    const consensus = computeConsensus(providers)
  return {
      symbol,
    updatedAt,
      providerCount: providers.length,
      consensus,
      providers,
  }
}

router.get(
  '/signal/open-source',
  asyncHandler(async (req: Request, res: Response) => {
    const symbolRaw = typeof req.query.symbol === 'string' ? req.query.symbol : 'BNBUSDT'
    const symbol = symbolRaw.toUpperCase().replace('/', '')
    const snapshot = await computeOpenSignalSnapshot(symbol)
    res.json(snapshot)
  })
)

router.get(
  '/signal/enhanced',
  asyncHandler(async (req: Request, res: Response) => {
    const symbolRaw = typeof req.query.symbol === 'string' ? req.query.symbol : 'BTCUSDT'
    const symbol = symbolRaw.toUpperCase().replace('/', '')
    const snapshot = await computeEnhancedSignalSnapshot(symbol)
    res.json(snapshot)
  })
)

const MULTI_SIGNAL_DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'USDCUSDT']

router.get(
  '/signal/multi',
  asyncHandler(async (req: Request, res: Response) => {
    const raw = typeof req.query.symbols === 'string' ? req.query.symbols : ''
    const requested = raw
      .split(',')
      .map((s) => s.trim().toUpperCase().replace('/', ''))
      .filter(Boolean)
    const symbols = requested.length > 0 ? requested.slice(0, 8) : MULTI_SIGNAL_DEFAULT_SYMBOLS
    const result = await computeMultiSymbolSnapshot(symbols)
    res.json(result)
  })
)

router.post(
  '/trade-advice',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const body = (req.body ?? {}) as {
      symbol?: string
      side?: string
      sizeUsdt?: number
      accountEquityUsdt?: number
    }
    const symbol = typeof body.symbol === 'string' && body.symbol.length > 0 ? body.symbol : 'BTCUSDT'
    const side: 'BUY' | 'SELL' = body.side === 'SELL' ? 'SELL' : 'BUY'
    const sizeUsdt = Number.isFinite(body.sizeUsdt) && (body.sizeUsdt as number) > 0 ? (body.sizeUsdt as number) : 0
    const accountEquityUsdt =
      typeof body.accountEquityUsdt === 'number' && Number.isFinite(body.accountEquityUsdt)
        ? body.accountEquityUsdt
        : null
    const advisory = await evaluateTradeIntent({
      userId,
      symbol,
      side,
      sizeUsdt,
      accountEquityUsdt,
    })
    res.json(advisory)
  })
)

router.get(
  '/signal/readiness',
  asyncHandler(async (req: Request, res: Response) => {
    const raw = typeof req.query.symbol === 'string' ? req.query.symbol : 'BTCUSDT'
    const symbol = binanceSpotAdapter.toSymbol(raw)
    const snapshot = await computeOpenSignalSnapshot(symbol)
    const ageMs = Date.now() - new Date(snapshot.updatedAt).getTime()
    const blockers: string[] = []
    if (snapshot.providerCount < MIN_SIGNAL_PROVIDER_COUNT) {
      blockers.push(`Need at least ${MIN_SIGNAL_PROVIDER_COUNT} signal providers online.`)
    }
    if (snapshot.consensus.confidence < MIN_SIGNAL_CONSENSUS_CONFIDENCE) {
      blockers.push(`Signal consensus confidence too low (${snapshot.consensus.confidence.toFixed(2)}).`)
    }
    if (!Number.isFinite(ageMs) || ageMs > MAX_SIGNAL_AGE_MS) {
      blockers.push('Signal feed is stale.')
    }
    res.json({
      ok: blockers.length === 0,
      symbol,
      minProviderCount: MIN_SIGNAL_PROVIDER_COUNT,
      minConsensusConfidence: MIN_SIGNAL_CONSENSUS_CONFIDENCE,
      maxSignalAgeMs: MAX_SIGNAL_AGE_MS,
      signalAgeMs: Number.isFinite(ageMs) ? ageMs : null,
      blockers,
      snapshot,
      venue: binanceSpotAdapter.describe(),
    })
  })
)

router.get(
  '/positions',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const rows = await getOpenPositionsForUser(userId)
    res.json({ positions: rows })
  })
)

router.get(
  '/logs',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '80'), 10) || 80))
    const logs = await listTradingLogs(userId, limit)
    res.json({
      logs: logs.map((l) => ({
        id: l.id,
        kind: l.kind,
        message: l.message,
        metadata: l.metadata,
        createdAt: l.createdAt.toISOString(),
      })),
    })
  })
)

/** Rough BSC swap gas (monitoring — compare to DEX / Trust Wallet at send time). */
const EST_SWAP_GAS_UNITS = 250_000

router.get(
  '/metrics',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const closed = await prisma.trade.findMany({
      where: { userId, status: 'CLOSED', pnl: { not: null } },
      select: { pnl: true },
    })
    const pnls = closed.map((t) => Number(t.pnl ?? 0))
    const wins = pnls.filter((p) => p > 0).length
    const totalTrades = closed.length
    const winRate = totalTrades > 0 ? wins / totalTrades : 0
    const totalPnl = pnls.reduce((a, b) => a + b, 0)

    const [portfolio, openPositions, book, gasGwei, bnbUsdt] = await Promise.all([
      prisma.portfolio.findUnique({ where: { userId } }),
      getOpenPositionsForUser(userId),
      fetchBookTicker('BTCUSDT'),
      fetchBscGasGwei(),
      fetchBnbUsdtPrice(),
    ])

    const unrealizedUsd = openPositions.reduce((s, p) => s + (p.pnlUsd ?? 0), 0)
    const bookTotal = Number(portfolio?.totalValue ?? 0)
    const realizedLifetimePnl = Number(portfolio?.pnl ?? 0)
    const liveAccountValueUsd = bookTotal + unrealizedUsd

    const mid = book?.mid
    const spreadBps =
      book && mid && mid > 0 ? ((book.ask - book.bid) / mid) * 10_000 : null

    const gasBnb =
      gasGwei !== null ? (gasGwei * EST_SWAP_GAS_UNITS) / 1e9 : null
    const estSwapGasUsd = gasBnb !== null && bnbUsdt !== null ? gasBnb * bnbUsdt : null

    res.json({
      totalTrades,
      winRate,
      winRatePct: Math.round(winRate * 1000) / 10,
      totalPnl,
      portfolioBookUsd: bookTotal,
      realizedPnlLifetime: realizedLifetimePnl,
      unrealizedPnlOpen: unrealizedUsd,
      liveAccountValueUsd,
      liveSpreadBps: spreadBps !== null ? Math.round(spreadBps * 10) / 10 : null,
      bscGasGwei: gasGwei,
      estSwapGasBnb: gasBnb !== null ? Math.round(gasBnb * 1e8) / 1e8 : null,
      estSwapGasUsd: estSwapGasUsd !== null ? Math.round(estSwapGasUsd * 100) / 100 : null,
      estSwapGasUnits: EST_SWAP_GAS_UNITS,
      bnbUsdt,
    })
  })
)

router.post(
  '/start',
  validate(engineStartSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const { strategyId, pair, mode, tradeSizePct, exchangeConnectionId, orderSizeUsdt: requestedOrderSizeUsdt } =
      (req as Request & {
        validated: {
          strategyId: string
          pair: 'BTC/USDT' | 'ETH/USDT' | 'BNB/USDT' | 'SOL/USDT' | 'XRP/USDT' | 'DOGE/USDT' | 'USDC/USDT'
          mode: 'wallet' | 'live'
          orderSizeUsdt?: number
          tradeSizePct?: number
          exchangeConnectionId?: string
        }
      }).validated

    /** UI slider % of free USDT per entry (capped by risk + CEX_LIVE_MAX_ORDER_USDT). */
    const resolvedTradeSizePct = tradeSizePct ?? 50

    const strategy = await prisma.strategy.findUnique({ where: { id: strategyId } })
    if (!strategy) {
      res.status(404).json({ error: 'Strategy not found' })
      return
    }

    const existingSession = await prisma.botSession.findFirst({ where: { userId, isActive: true } })
    if (existingSession) {
      res.status(400).json({ error: 'Bot is already running. Stop it first.' })
      return
    }

    if (mode === 'wallet') {
      res.status(400).json({
        error:
          'Real swaps use your Trust Wallet on BSC — open the DEX bot page, connect your wallet, and trade on PancakeSwap. This API route only starts Binance live automation.',
        dexPath: '/dex',
      })
      return
    }

    if (mode === 'live') {
      const signalSymbol = binanceSpotAdapter.toSymbol(pair)
      const signalReadiness = await computeOpenSignalSnapshot(signalSymbol)
      const startBlockers: string[] = []
      if (signalReadiness.providerCount < MIN_SIGNAL_PROVIDER_COUNT) {
        startBlockers.push(`Need at least ${MIN_SIGNAL_PROVIDER_COUNT} signal providers online.`)
      }
      if (signalReadiness.consensus.confidence < MIN_SIGNAL_CONSENSUS_CONFIDENCE) {
        startBlockers.push(
          `Signal consensus confidence too low (${signalReadiness.consensus.confidence.toFixed(2)}).`
        )
      }
      const signalAgeMs = Date.now() - new Date(signalReadiness.updatedAt).getTime()
      if (!Number.isFinite(signalAgeMs) || signalAgeMs > MAX_SIGNAL_AGE_MS) {
        startBlockers.push('Signal feed is stale.')
      }
      if (startBlockers.length > 0) {
        res.status(400).json({
          error: startBlockers[0],
          blockers: startBlockers,
          signalReadiness: {
            providerCount: signalReadiness.providerCount,
            consensus: signalReadiness.consensus,
            updatedAt: signalReadiness.updatedAt,
            symbol: signalSymbol,
          },
        })
        return
      }

      const readiness = await computeAutomationReadiness(userId, exchangeConnectionId)
      if (!readiness.ready) {
        res.status(400).json({
          error: readiness.blockers[0] ?? 'Live automation preflight checks failed.',
          blockers: readiness.blockers,
          settingsPath: '/settings',
          exchangePath: '/exchange',
        })
        return
      }

      const conn = await prisma.exchangeConnection.findFirst({
        where: { id: exchangeConnectionId!, userId, isActive: true },
      })
      if (!conn || !conn.canTrade) {
        res.status(400).json({
          error:
            'No active Binance connection with trading permission. On the Exchange page, connect your key and click Test (Spot / TRD_GRP_* permissions are detected). If you use IP restrictions on the key, whitelist the API server outbound IP shown there.',
        })
        return
      }
      if (conn.canWithdraw) {
        res.status(400).json({
          error:
            'Live automation requires a trade-only Binance API key. Withdraw-enabled keys are blocked for security.',
        })
        return
      }

      let realUsdt = 0
      try {
        realUsdt = await binanceSpotAdapter.getFreeUsdt(
          decryptSecret(conn.encryptedApiKey),
          decryptSecret(conn.encryptedSecret),
        )
      } catch {
        /* realUsdt already 0 */
      }
      if (!Number.isFinite(realUsdt) || realUsdt < 1) {
        res.status(400).json({
          error: `Binance USDT balance is $${realUsdt.toFixed(2)} — need at least $1. Deposit USDT on Binance first.`,
        })
        return
      }

      const riskRule = await prisma.riskRule.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      })
      const sized = binanceSpotAdapter.sizeLiveOrder({
        freeUsdt: realUsdt,
        tradeSizePct: resolvedTradeSizePct,
        requestedOrderSizeUsdt: requestedOrderSizeUsdt ?? null,
        maxOrderNotional: riskRule?.maxOrderNotional != null ? Number(riskRule.maxOrderNotional) : null,
        envMaxOrderUsdt: env.CEX_LIVE_MAX_ORDER_USDT,
      })
      const orderSizeUsdt = sized.orderSizeUsdt
      if (!Number.isFinite(orderSizeUsdt) || orderSizeUsdt < 5) {
        res.status(400).json({
          error:
            `Not enough USDT for a live order at ${resolvedTradeSizePct}% ` +
            `(sized $${orderSizeUsdt.toFixed(2)}, minimum $5). Deposit USDT, raise the size slider, ` +
            `or raise CEX_LIVE_MAX_ORDER_USDT / risk maxOrderNotional.`,
          sizing: sized,
          adapter: binanceSpotAdapter.describe(),
        })
        return
      }

      const session = await prisma.botSession.create({ data: { userId, strategyId, isActive: true } })
      const botRun = await prisma.botRun.create({ data: { userId, strategyId } })
      try {
        await liveTradingBot.start(userId, strategyId, pair, exchangeConnectionId!, orderSizeUsdt)
        await prisma.executionEvent.create({
          data: {
            userId,
            botRunId: botRun.id,
            eventType: ExecutionEventType.BOT_STARTED,
            payload: {
              source: 'binance-cex',
              adapterId: binanceSpotAdapter.id,
              venueClass: 'cex',
              routerRole: 'order_book',
              strategyId,
              pair,
              mode: 'live',
              tradeSizePct: resolvedTradeSizePct,
              exchangeConnectionId,
              orderSizeUsdt,
              freeUsdt: realUsdt,
              sizing: sized,
              adapter: binanceSpotAdapter.describe(),
            },
          },
        })
      } catch (err) {
        console.error('[engine/start live]', err)
        await prisma.botSession.delete({ where: { id: session.id } })
        await prisma.botRun.update({
          where: { id: botRun.id },
          data: { status: 'FAILED', stoppedAt: new Date(), stopReason: 'engine_start_failed' },
        })
        res.status(500).json({ error: 'Failed to start live bot engine' })
        return
      }

      res.status(201).json({
        sessionId: session.id,
        message: 'Live Binance CEX bot started',
        strategy: strategy.name,
        pair,
        mode: 'live',
        tradeSizePct: resolvedTradeSizePct,
        orderSizeUsdt,
        freeUsdt: realUsdt,
        sizing: sized,
        adapter: binanceSpotAdapter.describe(),
        automation: {
          enabled: true,
          executionEngine: 'binance-cex',
          venueClass: 'cex',
        },
      })
      return
    }

    res.status(400).json({
      error: 'Invalid mode. Use mode=live for Binance automation or mode=wallet for DEX flow.',
    })
  })
)

router.post(
  '/stop',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const session = await prisma.botSession.findFirst({ where: { userId, isActive: true } })
    if (!session) {
      res.status(404).json({ error: 'No active bot session found' })
      return
    }

    let stats = { sessionDuration: 0, totalTrades: 0 }
    try {
      if (liveTradingBot.isRunning(userId)) {
        stats = await liveTradingBot.stop(userId)
      }
    } catch {
      /* ignore */
    }

    await prisma.botSession.update({ where: { id: session.id }, data: { isActive: false, stoppedAt: new Date() } })
    const run = await prisma.botRun.findFirst({ where: { userId, status: 'RUNNING' }, orderBy: { startedAt: 'desc' } })
    if (run) {
      await prisma.botRun.update({
        where: { id: run.id },
        data: { status: 'STOPPED', stoppedAt: new Date(), stopReason: 'manual_stop' },
      })
      await prisma.executionEvent.create({
        data: { userId, botRunId: run.id, eventType: ExecutionEventType.BOT_STOPPED, payload: stats },
      })
    }
    res.json({ message: 'Bot stopped', sessionId: session.id, ...stats })
  })
)

const cexExitBody = z.object({
  enabled: z.boolean().optional(),
  takeProfitPct: z.number().min(0.2).max(50).optional(),
  stopLossPct: z.number().min(0.2).max(50).optional(),
  profitSkim: z.boolean().optional(),
  trailingStop: z.boolean().optional(),
  trailingActivationPct: z.number().min(0.2).max(10).optional(),
  trailingDeltaPct: z.number().min(0.1).max(10).optional(),
})

/** Per-position TP/SL overrides on the running Auto Binance lot (null = inherit global). */
const cexPositionExitBody = z.object({
  takeProfitPct: z.number().min(0.2).max(50).nullable().optional(),
  stopLossPct: z.number().min(0.2).max(50).nullable().optional(),
  trailingStop: z.boolean().nullable().optional(),
})

router.get(
  '/cex-exit',
  asyncHandler(async (req: Request, res: Response) => {
    const settings = await getCexExitSettings(req.user!.userId)
    res.json({
      settings,
      defaults: {
        takeProfitPct: env.CEX_LIVE_TAKE_PROFIT_PCT,
        stopLossPct: env.CEX_LIVE_STOP_LOSS_PCT,
        maxOrderUsdt: env.CEX_LIVE_MAX_ORDER_USDT,
      },
      note: 'CEX exits use Binance mark price (order book). Independent of Jupiter Super Machine exits.',
    })
  }),
)

router.put(
  '/cex-exit',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = cexExitBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid CEX exit settings', details: parsed.error.flatten() })
      return
    }
    const settings = await setCexExitSettings(req.user!.userId, parsed.data)
    res.json({ settings })
  }),
)

const cexSmBody = z.object({
  enabled: z.boolean().optional(),
  exchangeConnectionId: z.string().min(1).nullable().optional(),
  watchSymbol: z
    .enum(['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'SOL/USDT'])
    .optional(),
  maxTradeUsd: z.number().min(5).max(500).optional(),
  emergencyStop: z.boolean().optional(),
})

/** Binance CEX Super Machine — AI council gated, parallel to Jupiter Super Machine. */
router.get(
  '/cex-super-machine',
  asyncHandler(async (req: Request, res: Response) => {
    const status = await getCexSuperMachineStatus(req.user!.userId)
    res.json(status)
  }),
)

router.put(
  '/cex-super-machine',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = cexSmBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid CEX Super Machine settings', details: parsed.error.flatten() })
      return
    }
    if (parsed.data.enabled === true) {
      const saved = await getCexSuperMachineSettings(req.user!.userId)
      const readiness = await computeAutomationReadiness(
        req.user!.userId,
        parsed.data.exchangeConnectionId ?? saved.exchangeConnectionId ?? undefined,
      )
      if (!readiness.ready) {
        res.status(400).json({
          error: readiness.blockers[0] ?? 'CEX Super Machine preflight failed',
          blockers: readiness.blockers,
          exchangePath: '/exchange',
          settingsPath: '/settings',
        })
        return
      }
    }
    const settings = await setCexSuperMachineSettings(req.user!.userId, parsed.data)
    const status = await getCexSuperMachineStatus(req.user!.userId)
    res.json({ settings, status })
  }),
)

/** Update TP/SL/trailing on the RUNNING Auto Binance lot — applies from the next tick. */
router.put(
  '/cex-super-machine/position/exit-overrides',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = cexPositionExitBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid position exit overrides', details: parsed.error.flatten() })
      return
    }
    const result = await setCexPositionExitOverrides(req.user!.userId, parsed.data)
    if (!result.updated) {
      res.status(404).json({ error: 'No open Binance position to update' })
      return
    }
    res.json(result)
  }),
)

/** Manual profit skim — sells the profit slice into USDT, position keeps running. */
router.post(
  '/cex-super-machine/position/skim',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const result = await skimCexPositionProfit(req.user!.userId)
      res.json(result)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Skim failed' })
    }
  }),
)

router.get(
  '/cex-council/status',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(getCexCouncilStatus(req.user!.userId))
  }),
)

router.get(
  '/cex-council/decisions',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40))
    res.json({
      decisions: getRecentCexCouncilDecisions(req.user!.userId, limit),
      events: getRecentCexCouncilDecisions(req.user!.userId, limit),
      venue: 'binance-cex',
    })
  }),
)

/** Live Binance order book depth for Auto Trading terminal. */
router.get(
  '/order-book',
  asyncHandler(async (req: Request, res: Response) => {
    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : 'BTCUSDT'
    const limit = Number(req.query.limit) || 20
    try {
      const depth = await orderBookService.getDepth(symbol, limit)
      res.json(depth)
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : 'Order book unavailable' })
    }
  }),
)

/** Binance USDT market board (token recommendations / movers). */
router.get(
  '/market-board',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Number(req.query.limit) || 40
    try {
      const board = await getBinanceUsdtMarketBoard(limit)
      res.json(board)
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : 'Market board unavailable' })
    }
  }),
)

/** Multi-timeframe / 1-year context assembled from the stored candle history. */
router.get(
  '/market-context',
  asyncHandler(async (req: Request, res: Response) => {
    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : 'BTCUSDT'
    res.json(await getMarketContext(symbol))
  }),
)

/** How deep the candle store currently is — used to explain signal quality. */
router.get(
  '/candle-coverage',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await klineService.getCoverage())
  }),
)

// ─── Manual trading desk (Binance spot) ──────────────────────────────

router.get(
  '/manual/desk',
  asyncHandler(async (req: Request, res: Response) => {
    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : 'BTCUSDT'
    res.json(await getManualDesk(req.user!.userId, symbol))
  }),
)

const manualTradeSchema = z.object({
  symbol: z.string().min(4).max(32),
  side: z.enum(['BUY', 'SELL']),
  quoteOrderQty: z.number().positive().optional(),
  quantity: z.number().positive().optional(),
  fraction: z.number().positive().max(1).optional(),
  attachExits: z.boolean().optional(),
})

router.post(
  '/manual/preflight',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = manualTradeSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid manual trade request', details: parsed.error.flatten() })
      return
    }
    res.json(await previewManualTrade(req.user!.userId, parsed.data))
  }),
)

router.post(
  '/manual/trade',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = manualTradeSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid manual trade request', details: parsed.error.flatten() })
      return
    }
    try {
      res.json(await executeManualTrade(req.user!.userId, parsed.data))
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'Manual trade failed' })
    }
  }),
)

export default router
