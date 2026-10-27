-- Coupures de la surveillance (audit du 27/10/2026, P1-e, décision d'Alexandre) : périodes où le hub n'a plus Internet,
-- exclues du rapport client et des statistiques de disponibilité. Additive : nouvelle table, rien d'existant touché.
-- CreateTable
CREATE TABLE "MonitorBlackout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME,
    "cause" TEXT NOT NULL,
    "targets" INTEGER NOT NULL,
    "notifiedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "MonitorBlackout_endedAt_idx" ON "MonitorBlackout"("endedAt");

-- CreateIndex
CREATE INDEX "MonitorBlackout_startedAt_idx" ON "MonitorBlackout"("startedAt");

