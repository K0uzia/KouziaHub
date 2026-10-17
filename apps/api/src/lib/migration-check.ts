import { existsSync, readdirSync, readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@/lib/prisma.js";

// Une base en retard sur le client Prisma généré fait échouer chaque requête sur la table modifiée
// (cas réel en dev : 500 sur tout le portail). Vérifié au démarrage, exposé dans /api/health.

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../prisma/migrations");
const SCHEMA_FILE = path.resolve(MIGRATIONS_DIR, "../schema.prisma");

/** Dossiers de migration versionnés (ceux qui contiennent un migration.sql). */
export function listMigrationNames(dir = MIGRATIONS_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(dir, e.name, "migration.sql")))
    .map((e) => e.name)
    .sort();
}

/** Migrations du dépôt pas encore appliquées avec succès à la base. */
export function diffPending(available: string[], applied: string[]): string[] {
  const done = new Set(applied);
  return available.filter((name) => !done.has(name));
}

let pending: string[] = [];

export async function checkPendingMigrations(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
    `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
  );
  pending = diffPending(
    listMigrationNames(),
    rows.map((r) => r.migration_name),
  );
  return pending;
}

/** Modèles et champs déclarés dans schema.prisma (champs scalaires et relations, hors attributs @@). */
export function schemaFields(schemaText: string): Map<string, Set<string>> {
  const models = new Map<string, Set<string>>();
  let current: Set<string> | null = null;
  for (const raw of schemaText.split(/\r?\n/)) {
    const line = raw.trim();
    const open = /^model\s+(\w+)\s*\{/.exec(line);
    if (open) {
      current = new Set();
      models.set(open[1]!, current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("}")) {
      current = null;
      continue;
    }
    const field = /^(\w+)\s+\S/.exec(line);
    if (field && !line.startsWith("//")) current.add(field[1]!);
  }
  return models;
}

/**
 * Écarts entre schema.prisma et le client Prisma généré : modèles ou champs absents du client.
 * Cas réel : migrations appliquées sans `prisma generate`, une table neuve était undefined (500,
 * puis arrêt du serveur). Vide si le client est à jour.
 */
export function staleClientDiff(
  schemaText: string,
  clientModels: ReadonlyArray<{ name: string; fields: ReadonlyArray<{ name: string }> }>,
): string[] {
  const client = new Map(clientModels.map((m) => [m.name, new Set(m.fields.map((f) => f.name))]));
  const missing: string[] = [];
  for (const [model, fields] of schemaFields(schemaText)) {
    const known = client.get(model);
    if (!known) {
      missing.push(model);
      continue;
    }
    for (const f of fields) if (!known.has(f)) missing.push(`${model}.${f}`);
  }
  return missing;
}

/** Contrôle du démarrage : client Prisma généré à jour avec schema.prisma. */
export function checkPrismaClientUpToDate(): string[] {
  if (!existsSync(SCHEMA_FILE)) return [];
  return staleClientDiff(readFileSync(SCHEMA_FILE, "utf8"), Prisma.dmmf.datamodel.models);
}

/** Résultat du dernier contrôle (au démarrage), pour /api/health. */
export function pendingMigrationCount(): number {
  return pending.length;
}
