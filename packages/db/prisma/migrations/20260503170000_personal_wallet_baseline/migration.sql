-- Baseline for BSC PersonalWallet (was missing from early migration history).
-- Idempotent: safe on production (objects already exist) and required for fresh DBs
-- before 20260503180000_personal_wallet_day_anchor and Solana withdrawal migrations.

DO $$ BEGIN
  CREATE TYPE "PersonalWalletWithdrawalStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "PersonalWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL DEFAULT 56,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastUsdValue" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PersonalWallet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PersonalWallet_userId_key" ON "PersonalWallet"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "PersonalWallet_address_key" ON "PersonalWallet"("address");
CREATE INDEX IF NOT EXISTS "PersonalWallet_address_idx" ON "PersonalWallet"("address");

DO $$ BEGIN
  ALTER TABLE "PersonalWallet" ADD CONSTRAINT "PersonalWallet_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

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

CREATE UNIQUE INDEX IF NOT EXISTS "PersonalWalletWithdrawal_txHash_key" ON "PersonalWalletWithdrawal"("txHash");
CREATE INDEX IF NOT EXISTS "PersonalWalletWithdrawal_walletId_requestedAt_idx"
  ON "PersonalWalletWithdrawal"("walletId", "requestedAt" DESC);
CREATE INDEX IF NOT EXISTS "PersonalWalletWithdrawal_userId_status_requestedAt_idx"
  ON "PersonalWalletWithdrawal"("userId", "status", "requestedAt" DESC);

DO $$ BEGIN
  ALTER TABLE "PersonalWalletWithdrawal" ADD CONSTRAINT "PersonalWalletWithdrawal_walletId_fkey"
    FOREIGN KEY ("walletId") REFERENCES "PersonalWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PersonalWalletWithdrawal" ADD CONSTRAINT "PersonalWalletWithdrawal_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
