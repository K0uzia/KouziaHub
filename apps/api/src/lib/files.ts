import type { FilesResponse, VersionCheck } from "@/contract.js";
import { hostingOf, phpEntryCheck } from "@/lib/site-hosting.js";
import type { BlobStore } from "@/lib/blobs.js";
import { checkVersion } from "@/lib/version-check.js";
import { classifySitePath } from "@/lib/site-paths.js";
import { rulesOf, siteExtras } from "@/lib/site-extras.js";
import { HttpError } from "@/lib/http.js";
import { FILE_LIMITS, MAX_FILES, MAX_SITE_BYTES, maxFileBytesFor } from "@/lib/limits.js";
import { prisma } from "@/lib/prisma.js";

export type FileRef = { path: string; sha256: string; size: number };

const CHUNK = 400;
const chunks = <T>(items: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
};

export const CASE_CONFLICT = (other: string) => `Un fichier « ${other} » existe déjà avec le même nom à la casse près.`;

/**
 * Écarte les fichiers dont le nom ne diffère d'un autre que par la casse (Index.html contre index.html) :
 * Cloudflare les servirait tous deux, la plupart des postes de travail ne les distinguent pas.
 * `existing` : chemins déjà présents et conservés par l'opération.
 */
export function splitCaseConflicts(refs: FileRef[], existing: Iterable<string>): { kept: FileRef[]; rejected: Array<{ path: string; reason: string }> } {
  const seen = new Map<string, string>();
  for (const p of existing) seen.set(p.toLowerCase(), p);
  const kept: FileRef[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];
  for (const ref of refs) {
    const other = seen.get(ref.path.toLowerCase());
    if (other !== undefined && other !== ref.path) {
      rejected.push({ path: ref.path, reason: CASE_CONFLICT(other) });
      continue;
    }
    seen.set(ref.path.toLowerCase(), ref.path);
    kept.push(ref);
  }
  return { kept, rejected };
}

export async function workingPaths(siteId: string): Promise<string[]> {
  return (await prisma.workingFile.findMany({ where: { siteId }, select: { path: true } })).map((f) => f.path);
}

/** Contrôle de la version de travail (projet non construit, index.html absent) : lit package.json s'il est à la racine. */
export async function workingVersionCheck(files: Array<{ path: string; sha256: string }>, blobs: BlobStore): Promise<VersionCheck | null> {
  const pkg = files.find((f) => f.path === "package.json");
  const text = pkg ? await blobs.readText(pkg.sha256, 256 * 1024) : null;
  return checkVersion(
    files.map((f) => f.path),
    text,
  );
}

/** Fichiers de la version de travail que la règle refuse aujourd'hui (restes d'un envoi d'avant la règle), exceptions du site déduites. */
export async function leftoverDevFiles(siteId: string, paths: string[]): Promise<string[]> {
  const rules = rulesOf(await siteExtras(siteId));
  return paths.filter((p) => classifySitePath(p, rules).action === "reject");
}

export async function listFiles(siteId: string, blobs: BlobStore): Promise<FilesResponse> {
  const [files, site] = await Promise.all([
    prisma.workingFile.findMany({ where: { siteId }, orderBy: { path: "asc" } }),
    prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { workingDirty: true, hosting: true, phpPublicDir: true } }),
  ]);
  // Site PHP : page d'entrée (index.php ou index.html) dans le dossier public ; site Pages : index.html à la racine.
  const phpCheck = hostingOf(site) === "php" ? phpEntryCheck(files.map((f) => f.path), site.phpPublicDir ?? "") : undefined;
  return {
    files: files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, updatedAt: f.updatedAt.toISOString() })),
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
    hasIndex: phpCheck !== undefined ? phpCheck === null : files.some((f) => f.path === "index.html"),
    versionCheck: phpCheck !== undefined ? phpCheck : await workingVersionCheck(files, blobs),
    devFiles: await leftoverDevFiles(siteId, files.map((f) => f.path)),
    workingDirty: site.workingDirty,
    limits: { ...FILE_LIMITS, maxFileBytes: maxFileBytesFor(hostingOf(site)) },
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
  // Page d'attente servie : modifié dès qu'un fichier du site existe (le .htaccess généré seul ne compte pas). Sans
  // index.html, la barre de publication montre le contrôle de la version et « Publier quand même ».
  if (!version || version.source === "placeholder") return working.some((f) => f.path !== ".htaccess");
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
