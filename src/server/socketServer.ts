/**
 * Socket.IO — real-time layer (already in production).
 *
 * Backend engineers extending WebSockets should work here:
 *  - auth middleware (JWT from cookie or handshake.auth.token)
 *  - per-user rooms (`user:{userId}`)
 *  - bot → client event bridges (trade:executed, portfolio:update, …)
 *
 * Routes emit via `getSocketIo()` from `lib/realtimeHub.ts` — do not import index.ts.
 */
import type { Server as HttpServer } from 'http'
import jwt from 'jsonwebtoken'
import { Server, type Socket } from 'socket.io'
import { prisma } from '@cryptoflow/db'
import { env } from '../lib/env'
import { logger } from '../lib/logger'
import { registerSocketIo } from '../lib/realtimeHub'
import { pubsub } from '../lib/pubsub'
import { isDevAuthBypassActive } from '../lib/devAuth'
import { GLOBAL_PAPER_EMAIL } from '../services/bot/globalPaperTrader'
import { liveTradingBot } from '../services/bot/liveTradingBot'
import { advancedBot } from '../services/bot/advancedBot'
import { telegramService } from '../services/notifications/telegramService'
import { corsOriginHandler } from './cors'
import { startJupiterLiveTicker } from '../services/dex/jupiterLiveTickerService'

type JwtPayload = { userId: string }

const connectedSocketCounts = new Map<string, number>()

async function resolveSocketUserId(socket: Socket): Promise<string | null> {
  const authToken = socket.handshake.auth?.token as string | undefined
  const cookieToken = socket.handshake.headers.cookie
    ?.split('; ')
    .find((c) => c.startsWith('cf_token='))
    ?.split('=')[1]
  const token = authToken ?? cookieToken
  if (token) {
    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload
      return payload.userId
    } catch {
      return null
    }
  }
  if (isDevAuthBypassActive()) {
    const user = await prisma.user.findUnique({ where: { email: GLOBAL_PAPER_EMAIL } })
    return user?.id ?? null
  }
  return null
}

async function emitPortfolioUpdate(io: Server, userId: string): Promise<void> {
  const portfolio = await prisma.portfolio.findUnique({ where: { userId } })
  if (!portfolio) return
  io.to(`user:${userId}`).emit('portfolio:update', {
    totalValue: Number(portfolio.totalValue),
    pnl: Number(portfolio.pnl),
  })
}

type EmittedTrade = {
  id?: string
  pair?: string
  signal?: 'BUY' | 'SELL'
  price?: number
  entryPrice?: number
  exitPrice?: number
  pnl?: number
  status?: 'OPEN' | 'CLOSED'
  mode?: string
  notional?: number
  allocationUsd?: number
  openedAt?: string | Date
}

function pairToSymbol(pair: string | undefined): string {
  if (!pair) return ''
  return pair.replace('/', '').toUpperCase()
}

function notifyExecuted(
  data: { userId: string; trade: unknown; currentPnl: number },
  source: 'live-bot' | 'manual',
): void {
  const trade = (data.trade ?? {}) as EmittedTrade
  const symbol = pairToSymbol(trade.pair)
  const side: 'BUY' | 'SELL' = trade.signal === 'SELL' ? 'SELL' : 'BUY'
  const status = trade.status ?? 'OPEN'
  if (status === 'CLOSED') {
    const entry = Number(trade.entryPrice ?? trade.price ?? 0)
    const exit = Number(trade.exitPrice ?? trade.price ?? 0)
    const pnlUsdt = Number(trade.pnl ?? 0)
    const pnlPct = entry > 0 ? ((exit - entry) / entry) * 100 * (side === 'BUY' ? 1 : -1) : null
    void telegramService
      .notifyTradeClosed({
        userId: data.userId,
        symbol,
        exitPrice: exit,
        pnlUsdt,
        pnlPct,
      })
      .catch(() => null)
  } else {
    const entry = Number(trade.entryPrice ?? trade.price ?? 0)
    const notional = Number(trade.notional ?? trade.allocationUsd ?? 0)
    void telegramService
      .notifyTradeOpened({
        userId: data.userId,
        symbol,
        side,
        entryPrice: entry,
        notionalUsdt: notional,
        source,
      })
      .catch(() => null)
  }
}

function wireBotEvents(io: Server): void {
  liveTradingBot.on('trade:executed', (data: { userId: string; trade: unknown; currentPnl: number }) => {
    io.to(`user:${data.userId}`).emit('trade:executed', { trade: data.trade, currentPnl: data.currentPnl })
    io.to(`user:${data.userId}`).emit('performance:update')
    void emitPortfolioUpdate(io, data.userId)
    notifyExecuted(data, 'live-bot')
  })

  liveTradingBot.on('trade:failed', (data: { userId: string; error: { type: string; reason?: string; message: string } }) => {
    io.to(`user:${data.userId}`).emit('trade:failed', data.error)
    void telegramService
      .notifyTradeFailed({
        userId: data.userId,
        errorType: data.error?.type ?? 'UNKNOWN',
        message: data.error?.message ?? 'Trade failed',
      })
      .catch(() => null)
  })

  advancedBot.on('trade:executed', (data: { userId: string; trade: unknown; currentPnl: number }) => {
    io.to(`user:${data.userId}`).emit('trade:executed', { trade: data.trade, currentPnl: data.currentPnl })
    io.to(`user:${data.userId}`).emit('performance:update')
    void emitPortfolioUpdate(io, data.userId)
    notifyExecuted(data, 'live-bot')
  })

  liveTradingBot.on('bot:started', (data: { userId: string; pair: string; orderSizeUsdt: number }) => {
    void telegramService
      .notifyBotLifecycle({
        userId: data.userId,
        event: 'started',
        detail: `${data.pair} · ${data.orderSizeUsdt} USDT per entry`,
      })
      .catch(() => null)
  })

  liveTradingBot.on('bot:stopped', (data: { userId: string; sessionDuration: number; totalTrades: number }) => {
    void telegramService
      .notifyBotLifecycle({
        userId: data.userId,
        event: 'stopped',
        detail: `Duration ${Math.round(data.sessionDuration)}s · ${data.totalTrades} orders`,
      })
      .catch(() => null)
  })

  liveTradingBot.on('bot:emergency_stop', (data: { userId: string; reason: string }) => {
    void telegramService
      .notifyBotLifecycle({
        userId: data.userId,
        event: 'emergency_stop',
        detail: data.reason,
      })
      .catch(() => null)
    void telegramService
      .notifyRiskEvent({
        userId: data.userId,
        title: 'Capital protection halt',
        detail:
          'The live bot was stopped automatically by the capital protection circuit breaker. Review your trades and risk settings before restarting.',
      })
      .catch(() => null)
  })

  liveTradingBot.on(
    'advisor:blocked',
    (data: {
      userId: string
      symbol: string
      side: 'BUY' | 'SELL'
      reasons: Array<{ message: string; source: string; sourceUrl?: string }>
    }) => {
      void telegramService
        .notifyAdvisorBlock({
          userId: data.userId,
          symbol: data.symbol,
          side: data.side,
          reasons: data.reasons,
        })
        .catch(() => null)
    },
  )
}

export function createSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: corsOriginHandler,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-csrf-token', 'X-CSRF-Token'],
    },
  })
  registerSocketIo(io)

  io.use(async (socket, next) => {
    try {
      const userId = await resolveSocketUserId(socket)
      if (!userId) return next(new Error('Unauthorized'))
      socket.data.userId = userId
      next()
    } catch (err) {
      next(err as Error)
    }
  })

  io.on('connection', (socket) => {
    const userId = socket.data.userId as string
    socket.join(`user:${userId}`)
    connectedSocketCounts.set(userId, (connectedSocketCounts.get(userId) ?? 0) + 1)
    logger.info(`User ${userId} connected to socket`)

    socket.on('disconnect', () => {
      const current = connectedSocketCounts.get(userId) ?? 0
      if (current <= 1) connectedSocketCounts.delete(userId)
      else connectedSocketCounts.set(userId, current - 1)
      logger.info(`User ${userId} disconnected`)
    })
  })

  wireBotEvents(io)

  // Attach Redis adapter for horizontal scaling when Redis is available
  void (async () => {
    try {
      const { createAdapter } = await import('@socket.io/redis-adapter')
      const { getRedisClient, createRedisDuplicate } = await import('../lib/redis')
      const pubClient = await getRedisClient()
      if (pubClient) {
        const subClient = await createRedisDuplicate()
        if (subClient) {
          io.adapter(createAdapter(pubClient, subClient))
          logger.info('[socket] Redis adapter active — multi-instance clustering enabled')
        }
      }
    } catch {
      logger.info('[socket] Running with standalone in-memory socket adapter')
    }
  })()

  // Real-time market overview — reactive push (fires only on cache refresh, ~every 20s)
  pubsub.subscribe('jupiter:overview', (payload) => {
    io.emit('jupiter:overview', payload)
  })

  // Fast 2-second real-time price tick stream
  pubsub.subscribe('jupiter:ticker', (ticks) => {
    io.emit('jupiter:ticker', ticks)
  })

  // Cross-service event bridge (trading engine -> socket server)
  pubsub.subscribe('portfolio:update', (data: { userId?: string }) => {
    if (data?.userId) {
      void emitPortfolioUpdate(io, data.userId)
    }
  })

  pubsub.subscribe('trade:broadcast', (data: { userId: string; trade: unknown; currentPnl: number }) => {
    if (data?.userId) {
      io.to(`user:${data.userId}`).emit('trade:executed', { trade: data.trade, currentPnl: data.currentPnl })
      io.to(`user:${data.userId}`).emit('performance:update')
      void emitPortfolioUpdate(io, data.userId)
    }
  })

  startJupiterLiveTicker()

  return io
}
