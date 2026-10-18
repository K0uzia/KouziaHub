-- Surveillance des sites (cadrage 10.8) : abonnements Web Push, cibles, contrôles, agrégats horaires,
-- incidents, alertes envoyées, rapports mensuels. Additive : aucune table existante modifiée.
-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" DATETIME,
    "lastErrorAt" DATETIME,
    "lastError" TEXT,
    CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MonitorTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT,
    "siteRole" TEXT,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "erpClientId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "keyword" TEXT,
    "dnsReference" TEXT,
    "dnsReferenceAt" DATETIME,
    "contentHash" TEXT,
    "contentHashAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MonitorTarget_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MonitorCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "observer" TEXT NOT NULL,
    "at" DATETIME NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "status" INTEGER,
    "ms" INTEGER,
    "detail" TEXT,
    CONSTRAINT "MonitorCheck_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "MonitorTarget" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MonitorHourly" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetId" TEXT NOT NULL,
    "hour" DATETIME NOT NULL,
    "observer" TEXT NOT NULL,
    "checks" INTEGER NOT NULL,
    "failures" INTEGER NOT NULL,
    "avgMs" INTEGER,
    "p95Ms" INTEGER,
    CONSTRAINT "MonitorHourly_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "MonitorTarget" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MonitorIncident" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME,
    "cause" TEXT,
    "observers" TEXT NOT NULL,
    "notifiedAt" DATETIME,
    "recoveredNotifiedAt" DATETIME,
    "reminderAt" DATETIME,
    CONSTRAINT "MonitorIncident_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "MonitorTarget" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MonitorAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetId" TEXT,
    "kind" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MonitorReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MonitorReport_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "MonitorTarget" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE INDEX "MonitorTarget_siteId_idx" ON "MonitorTarget"("siteId");

-- CreateIndex
CREATE INDEX "MonitorTarget_hostname_idx" ON "MonitorTarget"("hostname");

-- CreateIndex
CREATE INDEX "MonitorCheck_targetId_kind_at_idx" ON "MonitorCheck"("targetId", "kind", "at");

-- CreateIndex
CREATE INDEX "MonitorCheck_kind_at_idx" ON "MonitorCheck"("kind", "at");

-- CreateIndex
CREATE INDEX "MonitorHourly_hour_idx" ON "MonitorHourly"("hour");

-- CreateIndex
CREATE UNIQUE INDEX "MonitorHourly_targetId_hour_observer_key" ON "MonitorHourly"("targetId", "hour", "observer");

-- CreateIndex
CREATE INDEX "MonitorIncident_targetId_startedAt_idx" ON "MonitorIncident"("targetId", "startedAt");

-- CreateIndex
CREATE INDEX "MonitorIncident_endedAt_idx" ON "MonitorIncident"("endedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MonitorAlert_dedupKey_key" ON "MonitorAlert"("dedupKey");

-- CreateIndex
CREATE INDEX "MonitorAlert_targetId_idx" ON "MonitorAlert"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "MonitorReport_targetId_month_key" ON "MonitorReport"("targetId", "month");

