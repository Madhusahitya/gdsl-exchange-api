-- Auto profit-skim toggle for the Binance CEX exit engine (parity with Jupiter).
ALTER TABLE "CexExitConfig" ADD COLUMN IF NOT EXISTS "profitSkim" BOOLEAN NOT NULL DEFAULT false;
