-- Logiciels génériques (« Nouveau logiciel », format KZ1, docs/licences-logiciels.md sections 3.7 et 5).
-- Additive : six colonnes facultatives ; Tracebay garde son format TB1, sa clé et ses licences. Validée le 23/10/2026.

-- AlterTable
ALTER TABLE "Software" ADD COLUMN "description" TEXT;
ALTER TABLE "Software" ADD COLUMN "demoUrl" TEXT;
ALTER TABLE "Software" ADD COLUMN "keyPrefix" TEXT;
ALTER TABLE "Software" ADD COLUMN "releasesUrl" TEXT;
ALTER TABLE "Software" ADD COLUMN "thumbnailAt" DATETIME;
ALTER TABLE "Software" ADD COLUMN "thumbnailPath" TEXT;

-- Tracebay : préfixe de son format.
UPDATE "Software" SET "keyPrefix" = 'TB1' WHERE "slug" = 'tracebay';

-- CreateIndex
CREATE UNIQUE INDEX "Software_keyPrefix_key" ON "Software"("keyPrefix");
