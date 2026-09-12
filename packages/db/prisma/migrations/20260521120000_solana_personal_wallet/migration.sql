-- CreateTable
CREATE TABLE "SolanaPersonalWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastUsdValue" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SolanaPersonalWallet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SolanaPersonalWallet_userId_key" ON "SolanaPersonalWallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SolanaPersonalWallet_address_key" ON "SolanaPersonalWallet"("address");

-- CreateIndex
CREATE INDEX "SolanaPersonalWallet_address_idx" ON "SolanaPersonalWallet"("address");

-- AddForeignKey
ALTER TABLE "SolanaPersonalWallet" ADD CONSTRAINT "SolanaPersonalWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
