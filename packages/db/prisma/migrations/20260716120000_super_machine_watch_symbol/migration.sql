-- Super Machine: optional pair lock (e.g. SOLUSDT) so the bot trades the chart-selected pair only.
ALTER TABLE "JupiterSuperMachineConfig" ADD COLUMN IF NOT EXISTS "watchSymbol" VARCHAR(32);
