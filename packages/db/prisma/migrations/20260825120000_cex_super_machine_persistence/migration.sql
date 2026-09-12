-- Binance CEX Super Machine config + open lot. Previously in-memory only, so an API
-- restart dropped the open position and its TP/SL watcher while the coin stayed on Binance.
CREATE TABLE "CexSuperMachineConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "exchangeConnectionId" TEXT,
    "watchSymbol" VARCHAR(32) NOT NULL DEFAULT 'BTCUSDT',
    "maxTradeUsd" DECIMAL(18,8) NOT NULL DEFAULT 25,
    "emergencyStop" BOOLEAN NOT NULL DEFAULT false,
    "openSymbol" VARCHAR(32),
    "openPair" VARCHAR(32),
    "openEntryPrice" DECIMAL(18,8),
    "openBaseQty" DECIMAL(28,12),
    "openQuoteSpent" DECIMAL(18,8),
    "openedAt" TIMESTAMP(3),
    "lastBuyAt" TIMESTAMP(3),
    "lastTickAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CexSuperMachineConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CexSuperMachineConfig_userId_key" ON "CexSuperMachineConfig"("userId");
CREATE INDEX "CexSuperMachineConfig_enabled_idx" ON "CexSuperMachineConfig"("enabled");

ALTER TABLE "CexSuperMachineConfig" ADD CONSTRAINT "CexSuperMachineConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-user TP/SL for the Binance CEX book. No column defaults: the service seeds new rows
-- from CEX_LIVE_TAKE_PROFIT_PCT / CEX_LIVE_STOP_LOSS_PCT so env stays the source of truth.
CREATE TABLE "CexExitConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "takeProfitPct" DECIMAL(8,4) NOT NULL,
    "stopLossPct" DECIMAL(8,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CexExitConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CexExitConfig_userId_key" ON "CexExitConfig"("userId");

ALTER TABLE "CexExitConfig" ADD CONSTRAINT "CexExitConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
