-- Cross-token cross-chain transfers: record the destination coin when it
-- differs from the source coin (swap + bridge). NULL means same-token.
ALTER TABLE "CrossChainTransfer" ADD COLUMN "destAsset" TEXT;
