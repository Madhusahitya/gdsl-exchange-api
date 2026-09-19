/**
 * Service 2: Dedicated Realtime Socket Gateway
 *
 * Dedicated to managing persistent client WebSocket connections:
 *  - Socket.IO handshakes & authentication
 *  - User-specific real-time rooms (`user:{userId}`)
 *  - Real-time market tick broadcasts (Jupiter live tickers)
 *  - Multi-instance scaling via @socket.io/redis-adapter
 *
 * Keeps thousands of persistent open TCP sockets isolated from the REST API.
 */
import { config as loadDotenv } from 'dotenv'
import { resolve as resolvePath } from 'node:path'
loadDotenv()
loadDotenv({ path: resolvePath(__dirname, '..', '.env') })
loadDotenv({ path: resolvePath(__dirname, '..', '..', '..', '.env') })

import { initNetworkFix } from './lib/dnsFix'
initNetworkFix()

import { createServer } from 'http'
import express from 'express'
import { env } from './lib/env'
import { logger } from './lib/logger'
import { createSocketServer } from './server/socketServer'
import { getRedisClient } from './lib/redis'

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandledRejection in Socket Gateway')
})

const app = express()

// Lightweight health check endpoint for reverse proxy / load balancer
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'socket-gateway', uptime: process.uptime() })
})

const httpServer = createServer(app)
const socketPort = env.SOCKET_PORT || 8001

createSocketServer(httpServer)

httpServer.listen(socketPort, async () => {
  logger.info(`[Socket Gateway] Realtime Socket.IO server running on port ${socketPort}`)
  void getRedisClient() // Warm up Redis connection
})
