-- Allow up to 3 Telegram chats per user (drop single-link constraint).
DROP INDEX IF EXISTS "TelegramLink_userId_key";
CREATE INDEX IF NOT EXISTS "TelegramLink_userId_idx" ON "TelegramLink"("userId");
