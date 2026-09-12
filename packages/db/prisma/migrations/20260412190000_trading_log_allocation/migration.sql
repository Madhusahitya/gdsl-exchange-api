-- AlterTable
ALTER TABLE "Trade" ADD COLUMN     "allocationUsd" DECIMAL(18,8);

-- CreateTable
CREATE TABLE "TradingLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradingLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TradingLog_userId_createdAt_idx" ON "TradingLog"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "TradingLog" ADD CONSTRAINT "TradingLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
