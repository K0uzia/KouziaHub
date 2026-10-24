-- Sites PHP (docs/cadrage.md, section 11, lot P3) : type d'hébergement par site, réglages PHP, pagesProject facultatif
-- (un site PHP n'a pas de projet Cloudflare Pages). Validée le 24/10/2026. SQLite ne sait pas rendre une colonne
-- facultative : la table Site est recréée à l'identique (copie de toutes les lignes, mêmes index), clés étrangères
-- suspendues pendant la copie (aucune suppression en cascade). Tous les sites existants restent « pages ».

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Site" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "erpClientId" TEXT,
    "label" TEXT,
    "hosting" TEXT NOT NULL DEFAULT 'pages',
    "pagesProject" TEXT,
    "phpVersion" TEXT,
    "phpPublicDir" TEXT,
    "phpPersistentDirs" TEXT,
    "phpHttpsOpen" BOOLEAN NOT NULL DEFAULT true,
    "phpImapOpen" BOOLEAN NOT NULL DEFAULT false,
    "pagesSubdomain" TEXT,
    "dnsRecordId" TEXT,
    "domainStatus" TEXT NOT NULL DEFAULT 'NONE',
    "state" TEXT NOT NULL DEFAULT 'CREATING',
    "currentVersionId" TEXT,
    "workingDirty" BOOLEAN NOT NULL DEFAULT false,
    "finalDomain" TEXT,
    "canonicalHost" TEXT NOT NULL DEFAULT 'www',
    "notFoundPage" TEXT NOT NULL DEFAULT '/404.html',
    "serverConfigHash" TEXT,
    "serverConfigAt" DATETIME,
    "devFilesAllowed" TEXT,
    "siteCsp" TEXT,
    "allowIndexing" BOOLEAN NOT NULL DEFAULT false,
    "thumbnailPath" TEXT,
    "thumbnailSource" TEXT,
    "thumbnailAt" DATETIME,
    "thumbnailFocus" TEXT,
    "touchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Site" ("allowIndexing", "canonicalHost", "createdAt", "currentVersionId", "devFilesAllowed", "dnsRecordId", "domainStatus", "erpClientId", "finalDomain", "id", "kind", "label", "notFoundPage", "pagesProject", "pagesSubdomain", "serverConfigAt", "serverConfigHash", "siteCsp", "slug", "state", "thumbnailAt", "thumbnailFocus", "thumbnailPath", "thumbnailSource", "touchedAt", "updatedAt", "workingDirty") SELECT "allowIndexing", "canonicalHost", "createdAt", "currentVersionId", "devFilesAllowed", "dnsRecordId", "domainStatus", "erpClientId", "finalDomain", "id", "kind", "label", "notFoundPage", "pagesProject", "pagesSubdomain", "serverConfigAt", "serverConfigHash", "siteCsp", "slug", "state", "thumbnailAt", "thumbnailFocus", "thumbnailPath", "thumbnailSource", "touchedAt", "updatedAt", "workingDirty" FROM "Site";
DROP TABLE "Site";
ALTER TABLE "new_Site" RENAME TO "Site";
CREATE UNIQUE INDEX "Site_slug_key" ON "Site"("slug");
CREATE UNIQUE INDEX "Site_pagesProject_key" ON "Site"("pagesProject");
CREATE INDEX "Site_erpClientId_idx" ON "Site"("erpClientId");
CREATE INDEX "Site_touchedAt_idx" ON "Site"("touchedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

