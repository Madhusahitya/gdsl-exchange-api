-- CreateEnum
CREATE TYPE "CrossChainTransferStatus" AS ENUM ('PENDING', 'DEBITED', 'COMPLETED', 'CREDIT_PENDING', 'FAILED');

-- CreateTable
CREATE TABLE "CrossChainTransfer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "asset" TEXT NOT NULL DEFAULT 'USDC',
    "amount" DECIMAL(28,12) NOT NULL,
    "feeUsd" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "creditAmount" DECIMAL(28,12) NOT NULL,
    "status" "CrossChainTransferStatus" NOT NULL DEFAULT 'PENDING',
    "debitTxRef" TEXT,
    "creditTxRef" TEXT,
    "errorMessage" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "CrossChainTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrossChainTransfer_userId_requestedAt_idx" ON "CrossChainTransfer"("userId", "requestedAt" DESC);

-- CreateIndex
CREATE INDEX "CrossChainTransfer_status_requestedAt_idx" ON "CrossChainTransfer"("status", "requestedAt" DESC);

-- AddForeignKey
ALTER TABLE "CrossChainTransfer" ADD CONSTRAINT "CrossChainTransfer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
