-- Per-user DEX Jupiter auto-exit prefs (TP/SL/profit skim) — previously in-memory only.
CREATE TABLE "JupiterExitConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "takeProfitPct" DECIMAL(8,4) NOT NULL DEFAULT 0.5,
    "stopLossPct" DECIMAL(8,4) NOT NULL DEFAULT 1.0,
    "trailingStop" BOOLEAN NOT NULL DEFAULT false,
    "profitSkim" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JupiterExitConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JupiterExitConfig_userId_key" ON "JupiterExitConfig"("userId");

ALTER TABLE "JupiterExitConfig" ADD CONSTRAINT "JupiterExitConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
