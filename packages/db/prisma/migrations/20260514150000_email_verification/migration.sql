-- Adds email-OTP verification fields to User.
-- See apps/api/src/routes/auth.ts and apps/api/src/services/email/emailService.ts.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "emailVerified"               BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "emailVerificationCodeHash"   TEXT,
  ADD COLUMN IF NOT EXISTS "emailVerificationExpiresAt"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "emailVerificationAttempts"   INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "emailVerificationLastSentAt" TIMESTAMP(3);

-- Existing users created before this migration are grandfathered as verified so
-- they don't get locked out of their accounts. Newly registered users default to FALSE.
UPDATE "User"
SET "emailVerified" = TRUE
WHERE "emailVerified" = FALSE
  AND "createdAt" < NOW();
