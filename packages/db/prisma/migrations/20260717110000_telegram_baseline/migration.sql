-- Baseline for Telegram alerts & OTP link codes (was missing from early migration history).
-- Idempotent: safe on production (objects already exist) and required for fresh DBs
-- before 20260717120000_telegram_multi_link.

CREATE TABLE IF NOT EXISTS "TelegramLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "prefs" JSONB NOT NULL DEFAULT '{}',
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TelegramLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TelegramLink_chatId_key" ON "TelegramLink"("chatId");
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramLink_userId_key" ON "TelegramLink"("userId");
CREATE INDEX IF NOT EXISTS "TelegramLink_isActive_idx" ON "TelegramLink"("isActive");

DO $$ BEGIN
  ALTER TABLE "TelegramLink" ADD CONSTRAINT "TelegramLink_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "TelegramLinkCode" (
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TelegramLinkCode_pkey" PRIMARY KEY ("code")
);

CREATE INDEX IF NOT EXISTS "TelegramLinkCode_userId_idx" ON "TelegramLinkCode"("userId");
CREATE INDEX IF NOT EXISTS "TelegramLinkCode_expiresAt_idx" ON "TelegramLinkCode"("expiresAt");

DO $$ BEGIN
  ALTER TABLE "TelegramLinkCode" ADD CONSTRAINT "TelegramLinkCode_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
