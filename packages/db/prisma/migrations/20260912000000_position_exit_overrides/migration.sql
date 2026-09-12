-- Per-position exit overrides on Trade (take-profit / stop-loss / trailing-stop)
-- plus tunable trailing-stop parameters on JupiterExitConfig.
-- All new Trade columns are nullable: existing rows keep using global settings.

ALTER TABLE "Trade" ADD COLUMN "takeProfitPct" DECIMAL(8,4);
ALTER TABLE "Trade" ADD COLUMN "stopLossPct" DECIMAL(8,4);
ALTER TABLE "Trade" ADD COLUMN "trailingStop" BOOLEAN;
ALTER TABLE "Trade" ADD COLUMN "trailingPeak" DECIMAL(18,8);

ALTER TABLE "JupiterExitConfig" ADD COLUMN "trailingActivationPct" DECIMAL(8,4) NOT NULL DEFAULT 0.8;
ALTER TABLE "JupiterExitConfig" ADD COLUMN "trailingDeltaPct" DECIMAL(8,4) NOT NULL DEFAULT 0.4;
