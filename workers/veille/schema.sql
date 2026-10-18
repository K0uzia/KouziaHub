-- Base D1 « kouzia-veille » du Worker de surveillance (cadrage, sections 10.2 et 10.8).
-- Version 1. Appliqué à chaque déploiement (hubctl veille deploy) : chaque instruction est rejouable.
-- Une évolution ajoute des instructions (ALTER TABLE ... ADD COLUMN, CREATE INDEX IF NOT EXISTS) et
-- relève schema_version ; rien n'est jamais supprimé ici.
-- Contenu : URL des cibles, états, incidents, abonnements push. Aucune donnée de client de l'ERP.

-- Cibles transmises par le hub (POST /sync). slot : tranche de minute (0 à 4) calculée par le Worker.
CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  keyword TEXT,
  slot INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS targets_slot ON targets (slot);

-- Dernier état par cible et par point de contrôle. Écrit seulement quand il change
-- (nombre d'échecs consécutifs ou succès/échec), jamais à chaque contrôle.
CREATE TABLE IF NOT EXISTS state (
  target_id TEXT NOT NULL,
  observer TEXT NOT NULL CHECK (observer IN ('hub', 'edge')),
  failures INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  status INTEGER,
  ms INTEGER,
  reason TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (target_id, observer)
);

-- Incidents (panne au sens du tableau 10.1) et notifications déjà envoyées.
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  basis TEXT NOT NULL,
  notified_at INTEGER,
  recovered_notified_at INTEGER,
  reminder_at INTEGER
);
CREATE INDEX IF NOT EXISTS incidents_open ON incidents (target_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS incidents_ended ON incidents (ended_at);

-- Abonnements Web Push recopiés par le hub (adresse du service push et clés publiques de l'appareil).
CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL
);

-- Valeurs uniques : battement de cœur du hub (hub_seen_at), dernier passage du Worker (edge_seen_at),
-- début du silence du hub déjà notifié (hub_offline_since), version du schéma.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- File d'envoi des notifications : une ligne par notification et par appareil, plafond par passage,
-- reprise au passage suivant, abandon après 5 essais ou 24 h.
CREATE TABLE IF NOT EXISTS push_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

INSERT INTO meta (key, value) VALUES ('schema_version', '1')
  ON CONFLICT (key) DO UPDATE SET value = excluded.value;
