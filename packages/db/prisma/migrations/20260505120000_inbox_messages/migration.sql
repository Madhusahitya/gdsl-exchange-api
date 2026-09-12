-- CreateEnum
CREATE TYPE "InboxCategory" AS ENUM ('TOKEN_TRADING_SIGNAL', 'BALANCE_ALLOCATION', 'SYSTEM');

-- CreateTable
CREATE TABLE "InboxMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "InboxCategory" NOT NULL,
    "title" VARCHAR(220) NOT NULL,
    "body" TEXT NOT NULL,
    "metadata" JSONB,
    "dedupeKey" VARCHAR(180),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboxMessage_userId_createdAt_idx" ON "InboxMessage"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "InboxMessage_userId_readAt_idx" ON "InboxMessage"("userId", "readAt");

-- CreateIndex
CREATE INDEX "InboxMessage_userId_dedupeKey_idx" ON "InboxMessage"("userId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "InboxMessage" ADD CONSTRAINT "InboxMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
