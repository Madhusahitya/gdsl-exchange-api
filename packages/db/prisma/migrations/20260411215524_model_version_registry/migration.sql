-- CreateTable
CREATE TABLE "ModelVersion" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sharpe" DOUBLE PRECISION,
    "sortino" DOUBLE PRECISION,
    "winRate" DOUBLE PRECISION,
    "maxDrawdown" DOUBLE PRECISION,
    "profitFactor" DOUBLE PRECISION,
    "totalReturn" DOUBLE PRECISION,
    "episodes" INTEGER,
    "trainedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promotedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "ModelVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModelVersion_status_idx" ON "ModelVersion"("status");

-- CreateIndex
CREATE INDEX "ModelVersion_trainedAt_idx" ON "ModelVersion"("trainedAt" DESC);
