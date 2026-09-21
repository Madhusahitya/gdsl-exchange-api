/**
 * Service 1: Core HTTP REST API (Stateless API Server)
 *
 * Dedicated to handling incoming user requests:
 *  - Authentication & Sessions
 *  - Dashboard queries & User Profiles
 *  - Trade submissions & Wallets
 *  - Settings & Fiat On-ramp
 *
 * This process contains NO background watchers, NO long-polling loops,
 * and NO heavy scheduled cron jobs. It can be scaled horizontally
 * behind any load balancer without risk of duplicate executions.
 */
import { config as loadDotenv } from 'dotenv'
import { resolve as resolvePath } from 'node:path'
loadDotenv()
loadDotenv({ path: resolvePath(__dirname, '..', '.env') })
loadDotenv({ path: resolvePath(__dirname, '..', '..', '..', '.env') })

import { initNetworkFix } from './lib/dnsFix'
initNetworkFix()

import { createServer } from 'http'
import { env } from './lib/env'
import { logger } from './lib/logger'
import { createApp } from './server/createApp'
import { createSocketServer } from './server/socketServer'
import { getRedisClient } from './lib/redis'

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandledRejection in API server')
})

const app = createApp()
const httpServer = createServer(app)

// Mount Socket.IO so localhost:8000 handles both REST API & WebSockets seamlessly
createSocketServer(httpServer)

httpServer.listen(env.PORT, async () => {
  logger.info(`[API Server] Core HTTP API running on http://localhost:${env.PORT}`)
  void getRedisClient() // Warm up Redis connection in background
})
