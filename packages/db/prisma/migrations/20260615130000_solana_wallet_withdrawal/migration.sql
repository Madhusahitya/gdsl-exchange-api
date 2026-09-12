-- CreateTable
CREATE TABLE "SolanaPersonalWalletWithdrawal" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" DECIMAL(28,12) NOT NULL,
    "txSignature" TEXT,
    "status" "PersonalWalletWithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "feeUsd" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "SolanaPersonalWalletWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SolanaPersonalWalletWithdrawal_txSignature_key" ON "SolanaPersonalWalletWithdrawal"("txSignature");

-- CreateIndex
CREATE INDEX "SolanaPersonalWalletWithdrawal_walletId_requestedAt_idx" ON "SolanaPersonalWalletWithdrawal"("walletId", "requestedAt" DESC);

-- CreateIndex
CREATE INDEX "SolanaPersonalWalletWithdrawal_userId_status_requestedAt_idx" ON "SolanaPersonalWalletWithdrawal"("userId", "status", "requestedAt" DESC);

-- AddForeignKey
ALTER TABLE "SolanaPersonalWalletWithdrawal" ADD CONSTRAINT "SolanaPersonalWalletWithdrawal_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "SolanaPersonalWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolanaPersonalWalletWithdrawal" ADD CONSTRAINT "SolanaPersonalWalletWithdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
