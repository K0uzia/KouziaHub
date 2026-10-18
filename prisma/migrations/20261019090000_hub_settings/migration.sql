-- Réglages du hub en clé-valeur (coordonnées du pied de page des rapports). Additive.
-- CreateTable
CREATE TABLE "HubSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

