-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "trialBalance" DECIMAL(18,8) NOT NULL DEFAULT 50;
ALTER TABLE "User" ADD COLUMN "referralCode" TEXT;
ALTER TABLE "User" ADD COLUMN "referredById" TEXT;

-- CreateTable
CREATE TABLE "Deposit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'COMPLETED',
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralReward" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralReward_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Deposit_userId_createdAt_idx" ON "Deposit"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ReferralReward_userId_createdAt_idx" ON "ReferralReward"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");
