/**
 * Service 3: Trading Engine & Position Watchers
 *
 * Dedicated to high-frequency position monitoring and automated bot execution:
 *  - DEX Open Position Watchers (Pancake, Jupiter, 1inch)
 *  - Take-Profit, Stop-Loss, Trailing Stop calculations
 *  - Multi-Agent AI Super Machine & Council evaluations
 *  - Binance CEX Automated Trader & Paper Trading
 *
 * Runs isolated from user-facing HTTP traffic. Emits events to Redis Pub/Sub
 * so the Socket Gateway pushes trade confirmations and PnL updates to users.
 */
import { config as loadDotenv } from 'dotenv'
import { resolve as resolvePath } from 'node:path'
loadDotenv()
loadDotenv({ path: resolvePath(__dirname, '..', '.env') })
loadDotenv({ path: resolvePath(__dirname, '..', '..', '..', '.env') })

import { initNetworkFix } from './lib/dnsFix'
initNetworkFix()

import { env } from './lib/env'
import { logger } from './lib/logger'
import { ensureStrategiesCatalog } from './services/ensureStrategiesCatalog'
import { startGlobalPaperTrader } from './services/bot/globalPaperTrader'
import { startDexOpenPositionWatcher } from './services/trading/dexOpenPositionWatcher'
import { startOneInchOpenPositionWatcher } from './services/trading/oneInchOpenPositionWatcher'
import { startJupiterOpenPositionWatcher } from './services/trading/jupiterOpenPositionWatcher'
import { startJupiterAutopilotWatcher } from './services/dex/jupiterAutopilotService'
import { startJupiterLimitOrderWatcher } from './services/dex/jupiterLimitOrderService'
import { startSuperMachineWatcher, loadSuperMachineFromDb } from './services/agents/superMachineService'
import { startCexSuperMachineWatcher, loadCexSuperMachineFromDb } from './services/agents/cexSuperMachineService'
import { warmJupiterTradableRegistry } from './services/dex/jupiterTradableRegistry'
import { getRedisClient } from './lib/redis'

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandledRejection in Trading Engine')
})

async function startTradingEngine(): Promise<void> {
  logger.info('[Trading Engine] Starting automated trading engine & position watchers...')
  await getRedisClient() // Ensure Redis connection is established

  try {
    await ensureStrategiesCatalog()
  } catch (err) {
    logger.error({ err }, '[Trading Engine] ensureStrategiesCatalog failed')
  }

  try {
    await startGlobalPaperTrader()
  } catch (err) {
    logger.error({ err }, '[Trading Engine] startGlobalPaperTrader failed')
  }

  // Start on-chain position watchers (TP / SL / Skim)
  startDexOpenPositionWatcher()
  startOneInchOpenPositionWatcher()
  startJupiterOpenPositionWatcher()
  startJupiterAutopilotWatcher()
  startJupiterLimitOrderWatcher()

  // Start AI autonomous trading agents
  startSuperMachineWatcher()
  startCexSuperMachineWatcher()
  void loadSuperMachineFromDb()
  void loadCexSuperMachineFromDb()

  if (env.JUPITER_API_KEY?.trim()) {
    logger.info('[Trading Engine] Warming Jupiter tradable registry...')
    warmJupiterTradableRegistry()
  }

  if (env.ONEINCH_API_KEY?.trim()) {
    void import('./services/dex/oneInchClassicService')
      .then((m) => m.fetchOneInchTokenMap())
      .then((map) => logger.info({ tokens: map.size }, '[Trading Engine] 1inch token map warmed'))
      .catch((err) => logger.warn({ err }, '[Trading Engine] 1inch token map warm-up failed'))
  }

  logger.info('[Trading Engine] All trading watchers and bots active and monitoring.')
}

void startTradingEngine()
