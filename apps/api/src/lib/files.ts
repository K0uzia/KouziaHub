import type { FilesResponse } from "@/contract.js";
import { HttpError } from "@/lib/http.js";
import { FILE_LIMITS, MAX_FILES, MAX_SITE_BYTES } from "@/lib/limits.js";
import { prisma } from "@/lib/prisma.js";

export type FileRef = { path: string; sha256: string; size: number };

const CHUNK = 400;
const chunks = <T>(items: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
};

export async function listFiles(siteId: string): Promise<FilesResponse> {
  const [files, site] = await Promise.all([
    prisma.workingFile.findMany({ where: { siteId }, orderBy: { path: "asc" } }),
    prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { workingDirty: true } }),
  ]);
  return {
    files: files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, updatedAt: f.updatedAt.toISOString() })),
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
    hasIndex: files.some((f) => f.path === "index.html"),
    workingDirty: site.workingDirty,
    limits: FILE_LIMITS,
  };
}

const fingerprint = (files: Array<{ path: string; sha256: string }>) =>
  files
    .map((f) => `${f.path}\u0000${f.sha256}`)
    .sort()
    .join("\n");

/**
 * Fichiers de travail différents de la version servie. Rien à publier (dossier vide) : pas modifié.
 * Page d'attente servie : modifié dès qu'un fichier existe.
 */
export async function computeDirty(siteId: string): Promise<boolean> {
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { currentVersionId: true } });
  if (!site) return false;
  const working = await prisma.workingFile.findMany({ where: { siteId }, select: { path: true, sha256: true } });
  if (working.length === 0) return false;
  if (!site.currentVersionId) return true;
  const version = await prisma.version.findUnique({
    where: { id: site.currentVersionId },
    select: { source: true, files: { select: { path: true, sha256: true } } },
  });
  if (!version || version.source === "placeholder") return true;
  return fingerprint(working) !== fingerprint(version.files);
}

export async function refreshDirty(siteId: string, touch = false): Promise<void> {
  const workingDirty = await computeDirty(siteId);
  await prisma.site.update({ where: { id: siteId }, data: { workingDirty, ...(touch ? { touchedAt: new Date() } : {}) } });
}

/**
 * Écrit des changements dans la version de travail en une transaction, après contrôle des plafonds
 * sur le résultat : tout ou rien.
 */
export async function applyWorkingChanges(
  siteId: string,
  change: { upserts?: FileRef[]; deletePaths?: string[]; deletePrefixes?: string[]; replaceAll?: boolean },
): Promise<void> {
  const upserts = new Map<string, FileRef>();
  for (const f of change.upserts ?? []) upserts.set(f.path, f);
  const existing = change.replaceAll
    ? []
    : await prisma.workingFile.findMany({ where: { siteId }, select: { path: true, size: true } });
  // Dossiers résolus en chemins exacts ici : LIKE de SQLite ignore la casse, « Assets/ » viserait « assets/ ».
  const prefixes = change.deletePrefixes ?? [];
  const deleted = new Set([...(change.deletePaths ?? []), ...existing.filter((f) => prefixes.some((p) => f.path.startsWith(p))).map((f) => f.path)]);
  const remaining = existing.filter((f) => !deleted.has(f.path) && !upserts.has(f.path));
  const count = remaining.length + upserts.size;
  const total = remaining.reduce((s, f) => s + f.size, 0) + [...upserts.values()].reduce((s, f) => s + f.size, 0);
  if (count > MAX_FILES) throw new HttpError(413, `Trop de fichiers : ${MAX_FILES} au plus par site.`);
  if (total > MAX_SITE_BYTES) throw new HttpError(413, `Site trop volumineux : ${Math.round(MAX_SITE_BYTES / 1024 / 1024)} Mio au plus.`);

  await prisma.$transaction(
    async (tx) => {
      if (change.replaceAll) {
        await tx.workingFile.deleteMany({ where: { siteId } });
      } else {
        for (const part of chunks([...deleted, ...upserts.keys()])) await tx.workingFile.deleteMany({ where: { siteId, path: { in: part } } });
      }
      for (const part of chunks([...upserts.values()])) {
        await tx.workingFile.createMany({ data: part.map((f) => ({ siteId, path: f.path, sha256: f.sha256, size: f.size })) });
      }
    },
    { timeout: 120_000 },
  );
  await refreshDirty(siteId, true);
}
