-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT NOT NULL,
    "totpSecretEncrypted" TEXT,
    "totpPendingSecretEncrypted" TEXT,
    "totpEnabledAt" DATETIME,
    "totpLastStep" INTEGER,
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AdminRecoveryCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdminLoginChallenge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminLoginChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "erpClientId" TEXT,
    "label" TEXT,
    "pagesProject" TEXT NOT NULL,
    "pagesSubdomain" TEXT,
    "dnsRecordId" TEXT,
    "domainStatus" TEXT NOT NULL DEFAULT 'NONE',
    "state" TEXT NOT NULL DEFAULT 'CREATING',
    "currentVersionId" TEXT,
    "workingDirty" BOOLEAN NOT NULL DEFAULT false,
    "thumbnailPath" TEXT,
    "thumbnailSource" TEXT,
    "thumbnailAt" DATETIME,
    "touchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WorkingFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkingFile_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Version" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "note" TEXT,
    "source" TEXT NOT NULL,
    "sourceVersionId" TEXT,
    "fileCount" INTEGER NOT NULL,
    "totalBytes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UPLOADING',
    "cfDeploymentId" TEXT,
    "cfDeploymentUrl" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" DATETIME,
    "purgedAt" DATETIME,
    CONSTRAINT "Version_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VersionFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "versionId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    CONSTRAINT "VersionFile_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "Version" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Operation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT,
    "siteSlug" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "steps" TEXT NOT NULL,
    "params" TEXT,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "Operation_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT,
    "siteSlug" TEXT,
    "action" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "detail" TEXT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "OrphanCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mode" TEXT NOT NULL,
    "findings" TEXT NOT NULL,
    "error" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AdminRecoveryCode_codeHash_key" ON "AdminRecoveryCode"("codeHash");

-- CreateIndex
CREATE INDEX "AdminRecoveryCode_userId_idx" ON "AdminRecoveryCode"("userId");

-- CreateIndex
CREATE INDEX "AdminLoginChallenge_userId_idx" ON "AdminLoginChallenge"("userId");

-- CreateIndex
CREATE INDEX "AdminLoginChallenge_expiresAt_idx" ON "AdminLoginChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Site_slug_key" ON "Site"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Site_pagesProject_key" ON "Site"("pagesProject");

-- CreateIndex
CREATE INDEX "Site_erpClientId_idx" ON "Site"("erpClientId");

-- CreateIndex
CREATE INDEX "Site_touchedAt_idx" ON "Site"("touchedAt");

-- CreateIndex
CREATE INDEX "WorkingFile_sha256_idx" ON "WorkingFile"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "WorkingFile_siteId_path_key" ON "WorkingFile"("siteId", "path");

-- CreateIndex
CREATE INDEX "Version_siteId_createdAt_idx" ON "Version"("siteId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Version_siteId_number_key" ON "Version"("siteId", "number");

-- CreateIndex
CREATE INDEX "VersionFile_sha256_idx" ON "VersionFile"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "VersionFile_versionId_path_key" ON "VersionFile"("versionId", "path");

-- CreateIndex
CREATE INDEX "Operation_siteId_startedAt_idx" ON "Operation"("siteId", "startedAt");

-- CreateIndex
CREATE INDEX "Operation_status_idx" ON "Operation"("status");

-- CreateIndex
CREATE INDEX "AuditEvent_siteId_at_idx" ON "AuditEvent"("siteId", "at");

-- CreateIndex
CREATE INDEX "AuditEvent_at_idx" ON "AuditEvent"("at");

