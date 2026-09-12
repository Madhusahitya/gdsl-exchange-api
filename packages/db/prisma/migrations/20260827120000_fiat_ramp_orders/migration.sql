-- CreateTable
CREATE TABLE "FiatRampOrder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "partnerOrderId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "fiatCurrency" TEXT NOT NULL,
    "cryptoCurrency" TEXT NOT NULL,
    "fiatAmount" DECIMAL(20,8),
    "cryptoAmount" DECIMAL(30,12),
    "walletAddress" TEXT NOT NULL,
    "walletSource" TEXT NOT NULL DEFAULT 'platform',
    "status" TEXT NOT NULL DEFAULT 'created',
    "providerOrderId" TEXT,
    "txHash" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiatRampOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FiatRampOrder_partnerOrderId_key" ON "FiatRampOrder"("partnerOrderId");

-- CreateIndex
CREATE INDEX "FiatRampOrder_userId_createdAt_idx" ON "FiatRampOrder"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "FiatRampOrder" ADD CONSTRAINT "FiatRampOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
