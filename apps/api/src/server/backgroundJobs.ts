import { logger } from '../lib/logger'
import { env } from '../lib/env'
import { reconcileOpenOrders } from '../services/reconcile'
import { klineService } from '../services/market/klineService'
import { orderBookService } from '../services/market/orderBook'
import { newsService } from '../services/news/newsService'
import { runPriorUpdate } from '../services/signals/priorUpdater'
import { runPriorBackfill } from '../services/signals/priorBackfill'
import { checkAndPromote } from '../services/ml/modelPromotion'
import { ensureStrategiesCatalog } from '../services/ensureStrategiesCatalog'
import { startGlobalPaperTrader } from '../services/bot/globalPaperTrader'
import { telegramPoller } from '../services/notifications/telegramPoller'
import { startDexOpenPositionWatcher } from '../services/trading/dexOpenPositionWatcher'
import { startOneInchOpenPositionWatcher } from '../services/trading/oneInchOpenPositionWatcher'
import { startJupiterOpenPositionWatcher } from '../services/trading/jupiterOpenPositionWatcher'
import { startJupiterAutopilotWatcher } from '../services/dex/jupiterAutopilotService'
import { startJupiterLimitOrderWatcher } from '../services/dex/jupiterLimitOrderService'
import { startSuperMachineWatcher, loadSuperMachineFromDb } from '../services/agents/superMachineService'
import { startCexSuperMachineWatcher, loadCexSuperMachineFromDb } from '../services/agents/cexSuperMachineService'
import { warmJupiterTradableRegistry } from '../services/dex/jupiterTradableRegistry'
import { retryAllPendingCrossChainCredits } from '../services/wallet/crossChainCreditRetryService'

/** Periodic timers — order reconciliation, cross-chain credits, ML priors. */
export function startBackgroundIntervals(): void {
  setInterval(async () => {
    try {
      await reconcileOpenOrders()
    } catch {
      /* avoid crashing on background reconciliation failures */
    }
  }, 20_000)

  setInterval(async () => {
    try {
      const n = await retryAllPendingCrossChainCredits(10)
      if (n > 0) logger.info({ count: n }, '[cross-chain] completed pending credits')
    } catch (err) {
      logger.warn({ err }, '[cross-chain] pending credit retry sweep failed')
    }
  }, 45_000)

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
}

/** Market feeds + position watchers — called once on boot. */
export function startBackgroundServices(): void {
  Promise.all([klineService.start(), newsService.start()])
    .then(() => {
      orderBookService.start()
      logger.info('Background market services started')
      runPriorBackfill().catch((err) => logger.error({ err }, '[priorBackfill] backfill failed'))
    })
    .catch((err) => logger.error({ err }, 'Background service startup error'))
}

/** Boot-time async init + trading watchers. */
export async function onServerListening(): Promise<void> {
  try {
    await ensureStrategiesCatalog()
  } catch (err) {
    logger.error({ err }, '[strategies] ensureStrategiesCatalog on boot failed')
  }
  try {
    await startGlobalPaperTrader()
  } catch (err) {
    logger.error({ err }, '[globalPaperTrader] boot failed')
  }

  if (telegramPoller.isEnabled()) {
    void telegramPoller.start().catch((err) => {
      logger.error({ err }, '[telegram-poller] failed to start')
    })
  }

  startDexOpenPositionWatcher()
  startOneInchOpenPositionWatcher()
  startJupiterOpenPositionWatcher()
  startJupiterAutopilotWatcher()
  startJupiterLimitOrderWatcher()
  startSuperMachineWatcher()
  startCexSuperMachineWatcher()
  void loadSuperMachineFromDb()
  void loadCexSuperMachineFromDb()

  if (env.JUPITER_API_KEY?.trim()) {
    logger.info('[jupiter] JUPITER_API_KEY loaded — DEX Jupiter quotes and swaps enabled')
    warmJupiterTradableRegistry()
  } else {
    logger.warn('[jupiter] JUPITER_API_KEY missing — add to server .env and restart API container')
  }

  if (env.ONEINCH_API_KEY?.trim()) {
    logger.info('[1inch] ONEINCH_API_KEY loaded — DEX 1inch quotes and swaps enabled')
    void import('../services/dex/oneInchClassicService')
      .then((m) => m.fetchOneInchTokenMap())
      .then((map) => logger.info({ tokens: map.size }, '[1inch] token map warmed'))
      .catch((err) => logger.warn({ err }, '[1inch] token map warm-up failed'))
  } else {
    logger.warn('[1inch] ONEINCH_API_KEY missing — add to server .env and restart API container')
  }
}
