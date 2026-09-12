ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lockoutUntil" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "AuthSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "refreshTokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "replacedById" TEXT,
  "userAgent" TEXT,
  "ipAddress" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AuthSession_refreshTokenHash_key" ON "AuthSession"("refreshTokenHash");
CREATE INDEX IF NOT EXISTS "AuthSession_userId_createdAt_idx" ON "AuthSession"("userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "AuthSession_userId_revokedAt_idx" ON "AuthSession"("userId", "revokedAt");
CREATE INDEX IF NOT EXISTS "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AuthSession_userId_fkey'
  ) THEN
    ALTER TABLE "AuthSession"
      ADD CONSTRAINT "AuthSession_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

