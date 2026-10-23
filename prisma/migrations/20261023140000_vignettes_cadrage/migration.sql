-- Vignettes : cadrage à l'affichage (logo entier ou capture qui remplit le cadre, point d'intérêt des sites).
-- Additive : trois colonnes facultatives, aucune donnée modifiée. Validée le 23/10/2026.

-- AlterTable
ALTER TABLE "Site" ADD COLUMN "thumbnailFocus" TEXT;

-- AlterTable
ALTER TABLE "Software" ADD COLUMN "thumbnailColor" TEXT;
ALTER TABLE "Software" ADD COLUMN "thumbnailFit" TEXT;
