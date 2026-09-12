-- Adds optional `username` column so internal users can sign in with a handle
-- (e.g. `godsland100`) instead of an email. Public registration remains email-
-- based; this column is only populated for pre-provisioned accounts.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "username" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key"
  ON "User"("username");
