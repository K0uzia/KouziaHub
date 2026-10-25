-- Sites PHP : chemins jamais envoyés (fichiers lourds jamais servis), décision du 25/10/2026.
-- Additive : une colonne facultative sur Site.
ALTER TABLE "Site" ADD COLUMN "phpExcludedPaths" TEXT;
