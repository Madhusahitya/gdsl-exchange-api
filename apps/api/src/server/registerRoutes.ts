import type { Express } from 'express'
import authRouter from '../routes/auth'
import portfolioRouter from '../routes/portfolio'
import tradesRouter from '../routes/trades'
import botRouter from '../routes/bot'
import strategiesRouter from '../routes/strategies'
import withdrawRouter from '../routes/withdraw'
import analyticsRouter from '../routes/analytics'
import performanceRouter from '../routes/performance'
import pricesRouter from '../routes/prices'
import exchangeRouter from '../routes/exchange'
import ordersRouter from '../routes/orders'
import walletRouter from '../routes/wallet'
import hotWalletRouter from '../routes/hotWallet'
import depositRouter from '../routes/deposit'
import dashboardRouter from '../routes/dashboard'
import referralRouter from '../routes/referral'
import engineRouter from '../routes/engine'
import riskRouter from '../routes/risk'
import marketFreeRouter from '../routes/marketFree'
import musicRouter from '../routes/music'
import telegramRouter from '../routes/telegram'
import personalWalletRouter from '../routes/personalWallet'
import dexNotifyRouter from '../routes/dexNotify'
import inboxRouter from '../routes/inbox'
import tokenTradingRouter from '../routes/tokenTrading'
import dexOneInchRouter from '../routes/dexOneInch'
import dexJupiterRouter from '../routes/dexJupiter'
import smartExecutionRouter from '../routes/smartExecution'
import supportRouter from '../routes/support'
import toolsRouter from '../routes/tools'
import onrampRouter from '../routes/onramp'

/** Mount every HTTP router — one import per domain area. */
export function registerRoutes(app: Express): void {
  app.use('/api/auth', authRouter)
  app.use('/api/portfolio', portfolioRouter)
  app.use('/api/trades', tradesRouter)
  app.use('/api/bot', botRouter)
  app.use('/api/strategies', strategiesRouter)
  app.use('/api/withdraw', withdrawRouter)
  app.use('/api/analytics', analyticsRouter)
  app.use('/api/performance', performanceRouter)
  app.use('/api/prices', pricesRouter)
  app.use('/api/exchange', exchangeRouter)
  app.use('/api/orders', ordersRouter)
  app.use('/api/wallet', walletRouter)
  app.use('/api/hot-wallet', hotWalletRouter)
  app.use('/api/deposit', depositRouter)
  app.use('/api/dashboard', dashboardRouter)
  app.use('/api/referral', referralRouter)
  app.use('/api/engine', engineRouter)
  app.use('/api/risk', riskRouter)
  app.use('/api/market/free', marketFreeRouter)
  app.use('/api/music', musicRouter)
  app.use('/api/telegram', telegramRouter)
  app.use('/api/personal-wallet', personalWalletRouter)
  app.use('/api/dex', dexNotifyRouter)
  app.use('/api/inbox', inboxRouter)
  app.use('/api/token-trading', tokenTradingRouter)
  app.use('/api/dex-1inch', dexOneInchRouter)
  app.use('/api/dex-jupiter', dexJupiterRouter)
  app.use('/api/smart-execution', smartExecutionRouter)
  app.use('/api/support', supportRouter)
  app.use('/api/tools', toolsRouter)
  app.use('/api/onramp', onrampRouter)
}
