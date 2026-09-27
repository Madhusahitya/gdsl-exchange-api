import type { Server } from 'node:http'
import { prisma } from '@cryptoflow/db'
import { logger } from './logger'

/**
 * Attaches SIGTERM and SIGINT listeners to ensure zero-downtime rolling updates.
 *
 * When Docker or the host initiates container replacement:
 * 1. Closes the HTTP server to stop accepting new requests.
 * 2. Allows existing in-flight HTTP requests and websocket frames to finish cleanly.
 * 3. Gracefully disconnects Prisma database client.
 * 4. Ensures a 15-second hard timeout so the process never hangs indefinitely.
 */
export function setupGracefulShutdown(
  httpServer: Server,
  serviceName: string,
  onCleanup?: () => Promise<void>,
): void {
  let isShuttingDown = false

  const handleSignal = (signal: string) => {
    if (isShuttingDown) return
    isShuttingDown = true

    logger.info({ signal, service: serviceName }, `[${serviceName}] ${signal} received. Initiating zero-downtime graceful shutdown...`)

    // Stop accepting new TCP connections
    httpServer.close(async (err) => {
      if (err) {
        logger.error({ err, service: serviceName }, `[${serviceName}] Error while closing HTTP server`)
      } else {
        logger.info({ service: serviceName }, `[${serviceName}] HTTP server closed. In-flight requests drained cleanly.`)
      }

      try {
        if (onCleanup) {
          await onCleanup()
        }
        await prisma.$disconnect()
        logger.info({ service: serviceName }, `[${serviceName}] Database disconnected cleanly.`)
      } catch (cleanupErr) {
        logger.error({ err: cleanupErr, service: serviceName }, `[${serviceName}] Error during shutdown cleanup`)
      } finally {
        process.exit(0)
      }
    })

    // Safety timeout: Docker gives 10s by default (stop_grace_period), give 15s max before force exit
    const forceExitTimer = setTimeout(() => {
      logger.warn({ service: serviceName }, `[${serviceName}] Graceful shutdown timeout (15s) elapsed. Forcing exit.`)
      process.exit(1)
    }, 15000)

    forceExitTimer.unref()
  }

  process.on('SIGTERM', () => handleSignal('SIGTERM'))
  process.on('SIGINT', () => handleSignal('SIGINT'))
}

/**
 * Attaches SIGTERM and SIGINT listeners for background worker and trading processes (non-HTTP).
 */
export function setupProcessShutdown(
  serviceName: string,
  onCleanup?: () => Promise<void>,
): void {
  let isShuttingDown = false

  const handleSignal = async (signal: string) => {
    if (isShuttingDown) return
    isShuttingDown = true

    logger.info({ signal, service: serviceName }, `[${serviceName}] ${signal} received. Initiating clean process shutdown...`)

    try {
      if (onCleanup) {
        await onCleanup()
      }
      await prisma.$disconnect()
      logger.info({ service: serviceName }, `[${serviceName}] Cleaned up and database disconnected cleanly.`)
    } catch (cleanupErr) {
      logger.error({ err: cleanupErr, service: serviceName }, `[${serviceName}] Error during process shutdown cleanup`)
    } finally {
      process.exit(0)
    }
  }

  process.on('SIGTERM', () => void handleSignal('SIGTERM'))
  process.on('SIGINT', () => void handleSignal('SIGINT'))
}
