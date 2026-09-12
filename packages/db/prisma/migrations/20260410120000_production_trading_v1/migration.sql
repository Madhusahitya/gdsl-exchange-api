-- CreateEnum
CREATE TYPE "ExchangeName" AS ENUM ('BINANCE');
CREATE TYPE "WalletSource" AS ENUM ('EXCHANGE', 'MANUAL');
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT', 'STOP_MARKET', 'TAKE_PROFIT_MARKET', 'TRAILING_STOP_MARKET');
CREATE TYPE "TimeInForce" AS ENUM ('GTC', 'IOC', 'FOK');
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_SUBMIT', 'NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED');
CREATE TYPE "RiskEventKind" AS ENUM ('ORDER_REJECTED', 'DAILY_LOSS_LIMIT', 'OPEN_EXPOSURE_LIMIT', 'LOSING_STREAK_COOLDOWN', 'CIRCUIT_BREAKER');
CREATE TYPE "RiskSeverity" AS ENUM ('INFO', 'WARN', 'CRITICAL');
CREATE TYPE "BotRunStatus" AS ENUM ('RUNNING', 'STOPPED', 'FAILED');
CREATE TYPE "ExecutionEventType" AS ENUM ('ORDER_SUBMITTED', 'ORDER_UPDATED', 'ORDER_FILLED', 'ORDER_CANCELED', 'ORDER_REJECTED', 'BOT_STARTED', 'BOT_STOPPED', 'RISK_TRIGGERED');

-- CreateTable
CREATE TABLE "ExchangeConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "exchange" "ExchangeName" NOT NULL,
    "label" TEXT,
    "encryptedApiKey" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "encryptedPassphrase" TEXT,
    "canTrade" BOOLEAN NOT NULL DEFAULT true,
    "canRead" BOOLEAN NOT NULL DEFAULT true,
    "canWithdraw" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExchangeConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WalletBalanceSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "exchangeConnectionId" TEXT NOT NULL,
    "source" "WalletSource" NOT NULL DEFAULT 'EXCHANGE',
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalUsdValue" DECIMAL(18,8) NOT NULL DEFAULT 0,
    CONSTRAINT "WalletBalanceSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WalletAssetBalance" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "free" DECIMAL(28,12) NOT NULL DEFAULT 0,
    "locked" DECIMAL(28,12) NOT NULL DEFAULT 0,
    "total" DECIMAL(28,12) NOT NULL DEFAULT 0,
    "usdValue" DECIMAL(18,8) NOT NULL DEFAULT 0,
    CONSTRAINT "WalletAssetBalance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "exchangeConnectionId" TEXT NOT NULL,
    "clientOrderId" TEXT NOT NULL,
    "exchangeOrderId" TEXT,
    "symbol" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "type" "OrderType" NOT NULL,
    "timeInForce" "TimeInForce",
    "quantity" DECIMAL(28,12) NOT NULL,
    "price" DECIMAL(28,12),
    "stopPrice" DECIMAL(28,12),
    "takeProfitPrice" DECIMAL(28,12),
    "trailingPercent" DECIMAL(8,4),
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_SUBMIT',
    "rejectReason" TEXT,
    "avgFillPrice" DECIMAL(28,12),
    "filledQuantity" DECIMAL(28,12) NOT NULL DEFAULT 0,
    "quoteQuantity" DECIMAL(28,12) NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StrategyPosition" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "strategyId" TEXT,
    "symbol" TEXT NOT NULL,
    "quantity" DECIMAL(28,12) NOT NULL DEFAULT 0,
    "avgEntryPrice" DECIMAL(28,12),
    "unrealizedPnl" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "realizedPnl" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StrategyPosition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PositionLot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "quantity" DECIMAL(28,12) NOT NULL,
    "entryPrice" DECIMAL(28,12) NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    CONSTRAINT "PositionLot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RiskRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "maxOrderNotional" DECIMAL(18,8),
    "maxOpenNotional" DECIMAL(18,8),
    "maxDailyLoss" DECIMAL(18,8),
    "cooldownMinutes" INTEGER DEFAULT 0,
    "maxLosingStreak" INTEGER DEFAULT 0,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RiskRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RiskEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "RiskEventKind" NOT NULL,
    "severity" "RiskSeverity" NOT NULL DEFAULT 'WARN',
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RiskEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BotRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "strategyId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),
    "status" "BotRunStatus" NOT NULL DEFAULT 'RUNNING',
    "stopReason" TEXT,
    CONSTRAINT "BotRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExecutionEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT,
    "botRunId" TEXT,
    "eventType" "ExecutionEventType" NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExecutionEvent_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "ExchangeConnection_userId_exchange_key" ON "ExchangeConnection"("userId", "exchange");
CREATE INDEX "ExchangeConnection_userId_isActive_idx" ON "ExchangeConnection"("userId", "isActive");
CREATE INDEX "WalletBalanceSnapshot_userId_capturedAt_idx" ON "WalletBalanceSnapshot"("userId", "capturedAt" DESC);
CREATE INDEX "WalletBalanceSnapshot_exchangeConnectionId_capturedAt_idx" ON "WalletBalanceSnapshot"("exchangeConnectionId", "capturedAt" DESC);
CREATE UNIQUE INDEX "WalletAssetBalance_snapshotId_asset_key" ON "WalletAssetBalance"("snapshotId", "asset");
CREATE INDEX "WalletAssetBalance_asset_idx" ON "WalletAssetBalance"("asset");
CREATE UNIQUE INDEX "Order_userId_clientOrderId_key" ON "Order"("userId", "clientOrderId");
CREATE INDEX "Order_userId_status_createdAt_idx" ON "Order"("userId", "status", "createdAt" DESC);
CREATE INDEX "Order_exchangeConnectionId_createdAt_idx" ON "Order"("exchangeConnectionId", "createdAt" DESC);
CREATE INDEX "Order_symbol_status_idx" ON "Order"("symbol", "status");
CREATE UNIQUE INDEX "StrategyPosition_userId_strategyId_symbol_key" ON "StrategyPosition"("userId", "strategyId", "symbol");
CREATE INDEX "StrategyPosition_userId_updatedAt_idx" ON "StrategyPosition"("userId", "updatedAt" DESC);
CREATE INDEX "PositionLot_userId_symbol_openedAt_idx" ON "PositionLot"("userId", "symbol", "openedAt" DESC);
CREATE INDEX "RiskRule_userId_isEnabled_idx" ON "RiskRule"("userId", "isEnabled");
CREATE INDEX "RiskEvent_userId_createdAt_idx" ON "RiskEvent"("userId", "createdAt" DESC);
CREATE INDEX "BotRun_userId_startedAt_idx" ON "BotRun"("userId", "startedAt" DESC);
CREATE INDEX "BotRun_status_idx" ON "BotRun"("status");
CREATE INDEX "ExecutionEvent_userId_createdAt_idx" ON "ExecutionEvent"("userId", "createdAt" DESC);
CREATE INDEX "ExecutionEvent_orderId_createdAt_idx" ON "ExecutionEvent"("orderId", "createdAt" DESC);

-- Foreign keys
ALTER TABLE "ExchangeConnection" ADD CONSTRAINT "ExchangeConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WalletBalanceSnapshot" ADD CONSTRAINT "WalletBalanceSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WalletBalanceSnapshot" ADD CONSTRAINT "WalletBalanceSnapshot_exchangeConnectionId_fkey" FOREIGN KEY ("exchangeConnectionId") REFERENCES "ExchangeConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WalletAssetBalance" ADD CONSTRAINT "WalletAssetBalance_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "WalletBalanceSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_exchangeConnectionId_fkey" FOREIGN KEY ("exchangeConnectionId") REFERENCES "ExchangeConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StrategyPosition" ADD CONSTRAINT "StrategyPosition_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StrategyPosition" ADD CONSTRAINT "StrategyPosition_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RiskRule" ADD CONSTRAINT "RiskRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RiskEvent" ADD CONSTRAINT "RiskEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BotRun" ADD CONSTRAINT "BotRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BotRun" ADD CONSTRAINT "BotRun_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExecutionEvent" ADD CONSTRAINT "ExecutionEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExecutionEvent" ADD CONSTRAINT "ExecutionEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExecutionEvent" ADD CONSTRAINT "ExecutionEvent_botRunId_fkey" FOREIGN KEY ("botRunId") REFERENCES "BotRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
