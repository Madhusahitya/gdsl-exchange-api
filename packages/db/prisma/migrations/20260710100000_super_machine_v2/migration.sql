-- Super Machine v2 enhancements

-- Add new fields to JupiterSuperMachineConfig
ALTER TABLE "JupiterSuperMachineConfig" ADD COLUMN IF NOT EXISTS "aggressiveMode" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "JupiterSuperMachineConfig" ADD COLUMN IF NOT EXISTS "trailingEntry" BOOLEAN NOT NULL DEFAULT true;

-- Update defaults for better profit optimization
ALTER TABLE "JupiterSuperMachineConfig" ALTER COLUMN "maxOpenPositions" SET DEFAULT 3;
ALTER TABLE "JupiterSuperMachineConfig" ALTER COLUMN "maxDailyTrades" SET DEFAULT 20;
ALTER TABLE "JupiterSuperMachineConfig" ALTER COLUMN "maxDailyVolumeUsd" SET DEFAULT 500;
ALTER TABLE "JupiterSuperMachineConfig" ALTER COLUMN "minLiquidityUsd" SET DEFAULT 100000;
