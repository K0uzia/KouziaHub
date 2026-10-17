-- Profil serveur du site : domaine final, forme canonique, page 404, empreinte du .htaccess généré.
ALTER TABLE "Site" ADD COLUMN "finalDomain" TEXT;
ALTER TABLE "Site" ADD COLUMN "canonicalHost" TEXT NOT NULL DEFAULT 'www';
ALTER TABLE "Site" ADD COLUMN "notFoundPage" TEXT NOT NULL DEFAULT '/404.html';
ALTER TABLE "Site" ADD COLUMN "serverConfigHash" TEXT;
ALTER TABLE "Site" ADD COLUMN "serverConfigAt" DATETIME;
