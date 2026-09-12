-- Auto Binance (CEX): per-position exit overrides on the Super Machine open lot
-- plus trailing-stop parameters on CexExitConfig.
-- All new columns are nullable or defaulted: existing rows keep current behavior.

ALTER TABLE "CexSuperMachineConfig" ADD COLUMN "openTakeProfitPct" DECIMAL(8,4);
ALTER TABLE "CexSuperMachineConfig" ADD COLUMN "openStopLossPct" DECIMAL(8,4);
ALTER TABLE "CexSuperMachineConfig" ADD COLUMN "openTrailingStop" BOOLEAN;
ALTER TABLE "CexSuperMachineConfig" ADD COLUMN "openTrailingPeak" DECIMAL(18,8);
ALTER TABLE "CexSuperMachineConfig" ADD COLUMN "openSkimmedUsd" DECIMAL(18,8);

ALTER TABLE "CexExitConfig" ADD COLUMN "trailingStop" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CexExitConfig" ADD COLUMN "trailingActivationPct" DECIMAL(8,4) NOT NULL DEFAULT 0.8;
ALTER TABLE "CexExitConfig" ADD COLUMN "trailingDeltaPct" DECIMAL(8,4) NOT NULL DEFAULT 0.4;
