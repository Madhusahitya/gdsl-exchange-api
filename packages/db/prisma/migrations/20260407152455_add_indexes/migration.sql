-- CreateIndex
CREATE INDEX "BotSession_userId_isActive_idx" ON "BotSession"("userId", "isActive");

-- CreateIndex
CREATE INDEX "Portfolio_userId_updatedAt_idx" ON "Portfolio"("userId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "Trade_userId_createdAt_idx" ON "Trade"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Trade_userId_status_idx" ON "Trade"("userId", "status");

-- CreateIndex
CREATE INDEX "Trade_userId_strategyId_idx" ON "Trade"("userId", "strategyId");

-- CreateIndex
CREATE INDEX "Trade_pair_idx" ON "Trade"("pair");
