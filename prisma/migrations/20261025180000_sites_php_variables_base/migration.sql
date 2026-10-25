-- Sites PHP, lot P4 (docs/cadrage.md, 11.5) : variables chiffrées, dossiers persistants publics, limites par site.
-- Additive : colonnes ajoutées à Site, valeurs par défaut pour les lignes existantes.
ALTER TABLE "Site" ADD COLUMN "phpEnv" TEXT;
ALTER TABLE "Site" ADD COLUMN "phpPublicPersistentDirs" TEXT;
ALTER TABLE "Site" ADD COLUMN "phpUploadMaxMb" INTEGER NOT NULL DEFAULT 32;
ALTER TABLE "Site" ADD COLUMN "phpMemoryLimitMb" INTEGER NOT NULL DEFAULT 256;
ALTER TABLE "Site" ADD COLUMN "phpMaxExecutionSec" INTEGER NOT NULL DEFAULT 30;
