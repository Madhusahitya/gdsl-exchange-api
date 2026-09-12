-- CreateTable
CREATE TABLE "WalletConvert" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "fromSymbol" TEXT NOT NULL,
    "toSymbol" TEXT NOT NULL,
    "inAmount" DECIMAL(28,12) NOT NULL,
    "outAmount" DECIMAL(28,12) NOT NULL,
    "txRef" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletConvert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WalletConvert_userId_requestedAt_idx" ON "WalletConvert"("userId", "requestedAt" DESC);

-- CreateIndex
CREATE INDEX "WalletConvert_userId_chain_requestedAt_idx" ON "WalletConvert"("userId", "chain", "requestedAt" DESC);

-- AddForeignKey
ALTER TABLE "WalletConvert" ADD CONSTRAINT "WalletConvert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
