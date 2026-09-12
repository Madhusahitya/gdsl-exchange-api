-- PersonalWallet: daily USD anchor for on-chain wallet "today" change on dashboard
ALTER TABLE "PersonalWallet"
  ADD COLUMN "dayAnchorUtcDate" DATE,
  ADD COLUMN "dayAnchorTotalUsd" DECIMAL(18,8);
