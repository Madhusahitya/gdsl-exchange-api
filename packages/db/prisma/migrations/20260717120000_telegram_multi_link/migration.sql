-- CreateTable: TelegramLink
CREATE TABLE IF NOT EXISTS "TelegramLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "prefs" JSONB NOT NULL DEFAULT '{}',
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable: TelegramLinkCode
CREATE TABLE IF NOT EXISTS "TelegramLinkCode" (
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramLinkCode_pkey" PRIMARY KEY ("code")
);

-- CreateIndexes
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramLink_chatId_key" ON "TelegramLink"("chatId");
CREATE INDEX IF NOT EXISTS "TelegramLink_userId_idx" ON "TelegramLink"("userId");
CREATE INDEX IF NOT EXISTS "TelegramLink_isActive_idx" ON "TelegramLink"("isActive");

CREATE INDEX IF NOT EXISTS "TelegramLinkCode_userId_idx" ON "TelegramLinkCode"("userId");
CREATE INDEX IF NOT EXISTS "TelegramLinkCode_expiresAt_idx" ON "TelegramLinkCode"("expiresAt");

-- AddForeignKeys
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TelegramLink_userId_fkey') THEN
    ALTER TABLE "TelegramLink" ADD CONSTRAINT "TelegramLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TelegramLinkCode_userId_fkey') THEN
    ALTER TABLE "TelegramLinkCode" ADD CONSTRAINT "TelegramLinkCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Allow up to 3 Telegram chats per user (drop single-link constraint).
DROP INDEX IF EXISTS "TelegramLink_userId_key";

