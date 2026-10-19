-- Règles du site (onglet Serveur) : fichiers de développement autorisés et CSP du site. Additive, nullables.
-- Validée par Alexandre le 19/10/2026 (option A, relayée par le superviseur).
ALTER TABLE "Site" ADD COLUMN "devFilesAllowed" TEXT;
ALTER TABLE "Site" ADD COLUMN "siteCsp" TEXT;
