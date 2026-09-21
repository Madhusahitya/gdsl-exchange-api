import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { prisma } from '@cryptoflow/db'
import { env } from '../lib/env'
import { requestLogger } from '../middleware/requestLogger'
import { errorHandler } from '../middleware/errorHandler'
import { apiLimiter, authLimiter, botLimiter, otpResendLimiter, otpVerifyLimiter } from '../middleware/rateLimiter'
import { corsOriginHandler } from './cors'
import { csrfProtection } from './csrf'
import { httpRequestDuration, metricsRegistry } from './metrics'
import { registerRoutes } from './registerRoutes'
import swaggerUi from 'swagger-ui-express'
import { swaggerSpec } from '../docs/swaggerSpec'

/** Build the Express app — middleware, health checks, and HTTP routes. */
export function createApp(): express.Application {
  const app = express()
  if (env.trustProxy) {
    app.set('trust proxy', 1)
  }

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'", env.FRONTEND_URL ?? 'http://localhost:3000', 'wss:', 'ws:', ...env.allowedCorsOrigins],
          fontSrc: ["'self'", 'https:', 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  )
  app.use(
    cors({
      origin: corsOriginHandler,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-csrf-token', 'X-CSRF-Token'],
    }),
  )
  app.use(express.json({ limit: '1mb' }))
  app.use(requestLogger)
  app.use(csrfProtection)

  app.use((req, res, next) => {
    const end = httpRequestDuration.startTimer()
    res.on('finish', () => {
      end({
        method: req.method,
        route: req.route?.path ?? req.path,
        status_code: res.statusCode,
      })
    })
    next()
  })

  app.use('/api', apiLimiter)
  app.use('/api/auth/login', authLimiter)
  app.use('/api/auth/register', authLimiter)
  app.use('/api/auth/verify-email', otpVerifyLimiter)
  app.use('/api/auth/resend-otp', otpResendLimiter)
  app.use('/api/bot/start', botLimiter)
  app.use('/api/bot/stop', botLimiter)
  app.use('/api/engine/start', botLimiter)
  app.use('/api/engine/stop', botLimiter)

  app.get('/', (_req, res) => {
    res.json({ name: 'CryptoFlow API', version: '1.0.0', docs: '/docs' })
  })

  // Swagger / OpenAPI 3.0 Interactive Documentation
  const swaggerUiOptions = {
    customSiteTitle: 'Godslandx Trading API Documentation',
    customCss: '.swagger-ui .topbar { display: none }',
  }
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerUiOptions))
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerUiOptions))
  app.get('/docs.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.json(swaggerSpec)
  })
  app.get('/api/docs.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.json(swaggerSpec)
  })

  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`
      res.json({ status: 'healthy', timestamp: new Date().toISOString(), uptime: process.uptime(), db: 'connected' })
    } catch {
      res.status(503).json({ status: 'unhealthy', timestamp: new Date().toISOString(), db: 'disconnected' })
    }
  })

  app.get('/health/live-automation', async (_req, res) => {
    const base = {
      timestamp: new Date().toISOString(),
      liveAutomationEnabled: env.LIVE_AUTOMATION_ENABLED,
      maintenanceReason: env.LIVE_AUTOMATION_MAINTENANCE_REASON ?? null,
    }
    try {
      await prisma.$queryRaw`SELECT 1`
      if (!env.LIVE_AUTOMATION_ENABLED) {
        res.status(503).json({
          ...base,
          status: 'maintenance',
          db: 'connected',
          message: env.LIVE_AUTOMATION_MAINTENANCE_REASON ?? 'Live automation is disabled by operator.',
        })
        return
      }
      res.json({
        ...base,
        status: 'ready',
        db: 'connected',
      })
    } catch {
      res.status(503).json({
        ...base,
        status: 'unhealthy',
        db: 'disconnected',
        message: 'Database is unavailable.',
      })
    }
  })

  app.get('/metrics', async (req, res) => {
    const secret = env.METRICS_BEARER_TOKEN
    if (secret) {
      if ((req.headers.authorization ?? '') !== `Bearer ${secret}`) {
        res.status(401).set('Content-Type', 'text/plain').send('Unauthorized')
        return
      }
    } else if (env.NODE_ENV === 'production') {
      res.status(404).set('Content-Type', 'text/plain').send('Not found')
      return
    }
    res.set('Content-Type', metricsRegistry.contentType)
    res.end(await metricsRegistry.metrics())
  })

  registerRoutes(app)
  app.use(errorHandler)

  return app
}
