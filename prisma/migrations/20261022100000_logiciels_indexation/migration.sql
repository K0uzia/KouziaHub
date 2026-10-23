-- Logiciels (licences Tracebay, docs/licences-logiciels.md section 5) et option d'indexation par site.
-- Additive : deux tables, une colonne à valeur par défaut. Validée le 22/10/2026 (cinquième série, sans révocation).

-- CreateTable
CREATE TABLE "Software" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "License" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "softwareId" TEXT NOT NULL,
    "entreprise" TEXT NOT NULL,
    "erpClientId" TEXT,
    "contactEncrypted" TEXT,
    "keyEncrypted" TEXT NOT NULL,
    "emise" TEXT NOT NULL,
    "expire" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "License_softwareId_fkey" FOREIGN KEY ("softwareId") REFERENCES "Software" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- AlterTable
ALTER TABLE "Site" ADD COLUMN "allowIndexing" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "Software_slug_key" ON "Software"("slug");

-- CreateIndex
CREATE INDEX "License_softwareId_expire_idx" ON "License"("softwareId", "expire");

-- CreateIndex
CREATE INDEX "License_erpClientId_idx" ON "License"("erpClientId");
