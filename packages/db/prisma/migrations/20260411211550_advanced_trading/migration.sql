-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ExecutionEventType" ADD VALUE 'SIGNAL_GENERATED';
ALTER TYPE "ExecutionEventType" ADD VALUE 'RL_PREDICTION';
ALTER TYPE "ExecutionEventType" ADD VALUE 'BAYES_DECISION';

-- CreateTable
CREATE TABLE "Kline" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "openTime" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(28,12) NOT NULL,
    "high" DECIMAL(28,12) NOT NULL,
    "low" DECIMAL(28,12) NOT NULL,
    "close" DECIMAL(28,12) NOT NULL,
    "volume" DECIMAL(28,12) NOT NULL,
    "quoteVolume" DECIMAL(28,12) NOT NULL,
    "trades" INTEGER NOT NULL,

    CONSTRAINT "Kline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feature" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "Feature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "source" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "direction" TEXT NOT NULL,
    "confidence" DECIMAL(6,5) NOT NULL,
    "rationale" JSONB,
    "outcome" TEXT,
    "returnPct" DECIMAL(10,6),

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BayesPrior" (
    "id" TEXT NOT NULL,
    "signalSource" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "alphaUp" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "betaUp" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "alphaDown" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "betaDown" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BayesPrior_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsEvent" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "symbolsMentioned" TEXT[],
    "sentimentScore" DECIMAL(6,5) NOT NULL,
    "rawPayload" JSONB,

    CONSTRAINT "NewsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelPrediction" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "action" TEXT NOT NULL,
    "qValues" JSONB,
    "confidence" DECIMAL(6,5) NOT NULL,
    "stateHash" TEXT,
    "shadow" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ModelPrediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RLEpisode" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "totalReward" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "stepCount" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,

    CONSTRAINT "RLEpisode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RLStep" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "t" INTEGER NOT NULL,
    "state" JSONB NOT NULL,
    "action" INTEGER NOT NULL,
    "reward" DECIMAL(18,8) NOT NULL,
    "nextState" JSONB,
    "done" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RLStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Kline_symbol_interval_openTime_idx" ON "Kline"("symbol", "interval", "openTime" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Kline_symbol_interval_openTime_key" ON "Kline"("symbol", "interval", "openTime");

-- CreateIndex
CREATE INDEX "Feature_symbol_ts_idx" ON "Feature"("symbol", "ts" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Feature_symbol_interval_ts_key" ON "Feature"("symbol", "interval", "ts");

-- CreateIndex
CREATE INDEX "Signal_source_symbol_ts_idx" ON "Signal"("source", "symbol", "ts" DESC);

-- CreateIndex
CREATE INDEX "Signal_symbol_ts_idx" ON "Signal"("symbol", "ts" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "BayesPrior_signalSource_symbol_interval_key" ON "BayesPrior"("signalSource", "symbol", "interval");

-- CreateIndex
CREATE INDEX "NewsEvent_publishedAt_idx" ON "NewsEvent"("publishedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "NewsEvent_source_externalId_key" ON "NewsEvent"("source", "externalId");

-- CreateIndex
CREATE INDEX "ModelPrediction_modelId_symbol_ts_idx" ON "ModelPrediction"("modelId", "symbol", "ts" DESC);

-- CreateIndex
CREATE INDEX "RLEpisode_modelId_startedAt_idx" ON "RLEpisode"("modelId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "RLStep_episodeId_t_idx" ON "RLStep"("episodeId", "t");

-- AddForeignKey
ALTER TABLE "RLStep" ADD CONSTRAINT "RLStep_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "RLEpisode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
