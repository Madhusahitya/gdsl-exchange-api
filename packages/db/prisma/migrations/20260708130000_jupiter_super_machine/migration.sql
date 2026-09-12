-- CreateTable
CREATE TABLE "JupiterSuperMachineConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "maxTradeUsd" DECIMAL(18,8) NOT NULL DEFAULT 25,
    "maxOpenPositions" INTEGER NOT NULL DEFAULT 2,
    "maxDailyTrades" INTEGER NOT NULL DEFAULT 12,
    "maxDailyVolumeUsd" DECIMAL(18,8) NOT NULL DEFAULT 300,
    "minLiquidityUsd" DECIMAL(18,8) NOT NULL DEFAULT 150000,
    "minSignal" TEXT NOT NULL DEFAULT 'rising',
    "emergencyStop" BOOLEAN NOT NULL DEFAULT false,
    "lastTickAt" TIMESTAMP(3),
    "lastTradeAt" TIMESTAMP(3),
    "tradesToday" INTEGER NOT NULL DEFAULT 0,
    "volumeTodayUsd" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "dayKey" TEXT,
    "botRunId" TEXT,
    "startedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JupiterSuperMachineConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JupiterSuperMachineConfig_userId_key" ON "JupiterSuperMachineConfig"("userId");

-- CreateIndex
CREATE INDEX "JupiterSuperMachineConfig_enabled_idx" ON "JupiterSuperMachineConfig"("enabled");

-- AddForeignKey
ALTER TABLE "JupiterSuperMachineConfig" ADD CONSTRAINT "JupiterSuperMachineConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
