/**
 * Service 4: Async Background Workers & Market Ingestion
 *
 * Dedicated to asynchronous scheduled tasks and external synchronization:
 *  - Binance open order reconciliation
 *  - Cross-chain credit retry sweeps
 *  - Binance Kline OHLCV candle ingestion & order book feeds
 *  - RSS news ingestion & sentiment scoring
 *  - ML Bayesian prior backfill & model promotions
 *  - Telegram Bot alerts & notification dispatchers
 *
 * Runs completely isolated from user-facing HTTP and WebSocket traffic.
 */
import { config as loadDotenv } from 'dotenv'
import { resolve as resolvePath } from 'node:path'
loadDotenv()
loadDotenv({ path: resolvePath(__dirname, '..', '.env') })
loadDotenv({ path: resolvePath(__dirname, '..', '..', '..', '.env') })

import { initNetworkFix } from './lib/dnsFix'
initNetworkFix()

import { logger } from './lib/logger'
import { reconcileOpenOrders } from './services/reconcile'
import { klineService } from './services/market/klineService'
import { orderBookService } from './services/market/orderBook'
import { newsService } from './services/news/newsService'
import { runPriorUpdate } from './services/signals/priorUpdater'
import { runPriorBackfill } from './services/signals/priorBackfill'
import { checkAndPromote } from './services/ml/modelPromotion'
import { telegramPoller } from './services/notifications/telegramPoller'
import { retryAllPendingCrossChainCredits } from './services/wallet/crossChainCreditRetryService'
import { getRedisClient } from './lib/redis'

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandledRejection in Background Worker')
})

async function startWorker(): Promise<void> {
  logger.info('[Background Worker] Starting background intervals and market data services...')
  await getRedisClient() // Warm up Redis connection

  // 1. Order Reconciliation (every 20s)
  setInterval(async () => {
    try {
      await reconcileOpenOrders()
    } catch (err) {
      logger.error({ err }, '[worker] reconcileOpenOrders loop failed')
    }
  }, 20_000)

  // 2. Cross-chain credit retries (every 45s)
  setInterval(async () => {
    try {
      const n = await retryAllPendingCrossChainCredits(10)
      if (n > 0) logger.info({ count: n }, '[cross-chain] completed pending credits')
    } catch (err) {
      logger.warn({ err }, '[cross-chain] pending credit retry sweep failed')
    }
  }, 45_000)

  // 3. ML Prior updates & promotions (every 60m)
  setInterval(async () => {
    try {
      await runPriorUpdate()
    } catch {
      /* non-critical */
    }
  }, 60 * 60 * 1000)

  setInterval(async () => {
    try {
      await checkAndPromote()
    } catch (err) {
      logger.warn({ err }, '[promotion] check failed')
    }
  }, 60 * 60 * 1000)

  // 4. Market Data Streams (Klines, OrderBook, News)
  try {
    await Promise.all([klineService.start(), newsService.start()])
    orderBookService.start()
    logger.info('[worker] Market data feeds (Klines, OrderBook, News) started')
    void runPriorBackfill().catch((err) => logger.error({ err }, '[priorBackfill] backfill failed'))
  } catch (err) {
    logger.error({ err }, '[worker] Market data feed startup failed')
  }

  // 5. Telegram Poller (if configured)
  if (telegramPoller.isEnabled()) {
    void telegramPoller.start().catch((err) => {
      logger.error({ err }, '[telegram-poller] failed to start')
    })
  }

  logger.info('[Background Worker] All background jobs and market streams active.')
}

void startWorker()
