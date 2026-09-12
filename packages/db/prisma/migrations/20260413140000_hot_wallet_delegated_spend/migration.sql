-- CreateTable
CREATE TABLE "HotWalletDelegatedSpend" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "usdtNotional" DECIMAL(18,8) NOT NULL,
    "wbnbAmount" DECIMAL(18,18),
    "txHash" TEXT NOT NULL,
    "approveTxHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HotWalletDelegatedSpend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HotWalletDelegatedSpend_userId_createdAt_idx" ON "HotWalletDelegatedSpend"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "HotWalletDelegatedSpend" ADD CONSTRAINT "HotWalletDelegatedSpend_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
