// Load envs from BOTH the API package's own .env and the monorepo root .env
// so secrets like WALLET_ENCRYPTION_KEY / DATABASE_URL keep working whether
// the dev/build script is invoked from the package or the repo root.
import { config as loadDotenv } from 'dotenv'
import { resolve as resolvePath } from 'node:path'
loadDotenv()
loadDotenv({ path: resolvePath(__dirname, '..', '.env') })
loadDotenv({ path: resolvePath(__dirname, '..', '..', '..', '.env') })

import { createServer } from 'http'
import { env } from './lib/env'
import { logger } from './lib/logger'
import { createApp } from './server/createApp'
import { createSocketServer } from './server/socketServer'
import { startBackgroundIntervals, startBackgroundServices, onServerListening } from './server/backgroundJobs'

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandledRejection')
})

const app = createApp()
const httpServer = createServer(app)

createSocketServer(httpServer)
startBackgroundIntervals()
startBackgroundServices()

httpServer.listen(env.PORT, () => {
  logger.info(`API running on http://localhost:${env.PORT}`)
  void onServerListening()
})
