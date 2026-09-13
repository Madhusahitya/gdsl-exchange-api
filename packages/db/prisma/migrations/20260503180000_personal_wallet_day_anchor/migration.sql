-- CreateEnum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PersonalWalletWithdrawalStatus') THEN
        CREATE TYPE "PersonalWalletWithdrawalStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
    END IF;
END $$;

-- CreateTable: PersonalWallet
CREATE TABLE IF NOT EXISTS "PersonalWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL DEFAULT 56,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastUsdValue" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "dayAnchorUtcDate" DATE,
    "dayAnchorTotalUsd" DECIMAL(18,8),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonalWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable: PersonalWalletWithdrawal
CREATE TABLE IF NOT EXISTS "PersonalWalletWithdrawal" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" DECIMAL(28,12) NOT NULL,
    "txHash" TEXT,
    "status" "PersonalWalletWithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "feeUsd" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "PersonalWalletWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndexes for PersonalWallet
CREATE UNIQUE INDEX IF NOT EXISTS "PersonalWallet_userId_key" ON "PersonalWallet"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "PersonalWallet_address_key" ON "PersonalWallet"("address");
CREATE INDEX IF NOT EXISTS "PersonalWallet_address_idx" ON "PersonalWallet"("address");

-- CreateIndexes for PersonalWalletWithdrawal
CREATE UNIQUE INDEX IF NOT EXISTS "PersonalWalletWithdrawal_txHash_key" ON "PersonalWalletWithdrawal"("txHash");
CREATE INDEX IF NOT EXISTS "PersonalWalletWithdrawal_walletId_requestedAt_idx" ON "PersonalWalletWithdrawal"("walletId", "requestedAt" DESC);
CREATE INDEX IF NOT EXISTS "PersonalWalletWithdrawal_userId_status_requestedAt_idx" ON "PersonalWalletWithdrawal"("userId", "status", "requestedAt" DESC);

-- AddForeignKeys
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PersonalWallet_userId_fkey') THEN
    ALTER TABLE "PersonalWallet" ADD CONSTRAINT "PersonalWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PersonalWalletWithdrawal_walletId_fkey') THEN
    ALTER TABLE "PersonalWalletWithdrawal" ADD CONSTRAINT "PersonalWalletWithdrawal_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "PersonalWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PersonalWalletWithdrawal_userId_fkey') THEN
    ALTER TABLE "PersonalWalletWithdrawal" ADD CONSTRAINT "PersonalWalletWithdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

