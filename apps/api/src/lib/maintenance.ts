// Purges (fichiers d'un site, cache du hub, cache Cloudflare) et place utilisée.
import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { CachePurgeResult, HubCachePurgeInput, HubCachePurgeResult, PurgeCount, SiteFilesPurgeResult, StorageUsage } from "@/contract.js";
import { audit } from "@/lib/audit.js";
import { CF_PURGE_RATE_LIMITED, CF_PURGE_REFUSED, CloudflareError } from "@/lib/cloudflare/types.js";
import { applyWorkingChanges, listFiles, type FileRef } from "@/lib/files.js";
import { HttpError } from "@/lib/http.js";
import { finalHost } from "@/lib/monitor/targets.js";
import { isUploadSessionBusy } from "@/lib/uploads.js";
import { prisma } from "@/lib/prisma.js";
import { hostnameOf } from "@/lib/publish.js";
import { hubZoneConflict } from "@/lib/slug.js";
import type { Services } from "@/lib/services.js";

/** Taille d'un dossier (fichiers seulement, récursif) et nombre de fichiers. */
async function dirSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await dirSize(full);
      bytes += sub.bytes;
      files += sub.files;
    } else if (e.isFile()) {
      bytes += (await stat(full).catch(() => null))?.size ?? 0;
      files++;
    }
  }
  return { bytes, files };
}

/** Sessions d'envoi par morceaux : dossier, site et taille (hors sessions illisibles, comptées sans site). */
async function uploadSessions(dataDir: string): Promise<Array<{ dir: string; siteId: string | null; bytes: number }>> {
  const root = path.join(dataDir, "uploads");
  const out: Array<{ dir: string; siteId: string | null; bytes: number }> = [];
  for (const id of await readdir(root).catch(() => [] as string[])) {
    const dir = path.join(root, id);
    let siteId: string | null = null;
    try {
      siteId = (JSON.parse(await readFile(path.join(dir, "session.json"), "utf8")) as { siteId?: string }).siteId ?? null;
    } catch {
      siteId = null;
    }
    out.push({ dir, siteId, bytes: (await dirSize(dir)).bytes });
  }
  return out;
}

const TEMP_GRACE_MS = 10 * 60_000;

// --- Fichiers d'un site ---

/**
 * Vide la version de travail ; option : purge des anciennes versions (déploiement Cloudflare supprimé,
 * statut PURGED), en gardant toujours la version servie. Un échec Cloudflare laisse la version intacte
 * et figure au rapport : jamais d'état à moitié purgé.
 */
/**
 * Version de travail remplacée par `upserts` en une seule écriture : les fichiers absents sont retirés et leurs
 * objets libérés s'ils ne servent plus. « Vider les fichiers » (upserts vide) et « Remplacer tout le contenu »
 * d'un envoi passent par ici. Appelant : sous le verrou du site.
 */
export async function replaceWorkingFiles(services: Services, siteId: string, upserts: FileRef[]): Promise<{ removed: number; freedBytes: number }> {
  const before = await prisma.workingFile.findMany({ where: { siteId }, select: { path: true, sha256: true } });
  await applyWorkingChanges(siteId, { replaceAll: true, upserts });
  const keptPaths = new Set(upserts.map((f) => f.path));
  const keptBlobs = new Set(upserts.map((f) => f.sha256));
  const freed = await services.blobs.releaseUnused(before.map((w) => w.sha256).filter((sha) => !keptBlobs.has(sha)));
  invalidateStorageUsage();
  return { removed: before.filter((w) => !keptPaths.has(w.path)).length, freedBytes: freed.bytes };
}

export async function purgeSiteFiles(services: Services, siteId: string, withVersions: boolean): Promise<SiteFilesPurgeResult> {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
  const working = await prisma.workingFile.findMany({ where: { siteId }, select: { sha256: true } });
  const candidates: string[] = [];
  const emptied = await replaceWorkingFiles(services, siteId, []);

  let versions: SiteFilesPurgeResult["versions"] = null;
  if (withVersions) {
    const list = await prisma.version.findMany({ where: { siteId, status: { in: ["PUBLISHED", "FAILED"] } }, orderBy: { number: "asc" } });
    const current = list.find((v) => v.id === site.currentVersionId);
    const purged: number[] = [];
    const failed: Array<{ number: number; error: string }> = [];
    const keptCurrent = new Set<number>(current ? [current.number] : []);
    for (const v of list) {
      // Version servie relue à chaque tour : elle n'est jamais purgée, même si elle a changé entre-temps.
      const servedId = (await prisma.site.findUnique({ where: { id: siteId }, select: { currentVersionId: true } }))?.currentVersionId;
      if (v.id === servedId || v.id === site.currentVersionId) {
        keptCurrent.add(v.number);
        continue;
      }
      try {
        if (v.cfDeploymentId) await services.cloudflare.deleteDeployment(site.pagesProject, v.cfDeploymentId);
      } catch (err) {
        failed.push({ number: v.number, error: err instanceof Error ? err.message.slice(0, 200) : "erreur Cloudflare" });
        continue;
      }
      const files = await prisma.versionFile.findMany({ where: { versionId: v.id }, select: { sha256: true } });
      try {
        await prisma.$transaction([
          prisma.versionFile.deleteMany({ where: { versionId: v.id } }),
          prisma.version.update({ where: { id: v.id }, data: { status: "PURGED", purgedAt: new Date() } }),
        ]);
      } catch {
        // Déploiement déjà supprimé chez Cloudflare, base inchangée : la version reste listée (sans
        // déploiement), ses fichiers seront libérés par une prochaine purge.
        failed.push({ number: v.number, error: "Déploiement supprimé chez Cloudflare, mais la base n'a pas pu être mise à jour : relancez la purge." });
        continue;
      }
      candidates.push(...files.map((f) => f.sha256));
      purged.push(v.number);
    }
    versions = { purged, kept: [...keptCurrent, ...failed.map((f) => f.number)].sort((a, b) => a - b), failed };
    await audit({
      action: "versions.purge",
      result: failed.length ? "error" : "ok",
      siteId,
      siteSlug: site.slug,
      detail: `${purged.length} purgée(s)${failed.length ? `, ${failed.length} en échec chez Cloudflare` : ""}`,
    });
  }
  const freed = await services.blobs.releaseUnused(candidates);
  invalidateStorageUsage();
  await audit({ action: "files.purge", result: "ok", siteId, siteSlug: site.slug, detail: `${working.length} fichier(s) de travail` });
  return { removedFiles: working.length, versions, freedBytes: freed.bytes + emptied.freedBytes, files: await listFiles(siteId, services.blobs) };
}

// --- Place utilisée ---

/** Place utilisée gardée 10 s (le calcul lit tout le magasin d'objets), vidée à chaque purge. */
const USAGE_TTL_MS = 10_000;
let usageCache: { at: number; dataDir: string; value: StorageUsage } | null = null;

export function invalidateStorageUsage(): void {
  usageCache = null;
}

export async function storageUsage(services: Services): Promise<StorageUsage> {
  if (usageCache && usageCache.dataDir === services.dataDir && Date.now() - usageCache.at < USAGE_TTL_MS) return usageCache.value;
  // Sommes par site en deux requêtes agrégées : chaque contenu compté une fois ; versions gardées hors contenus
  // déjà présents dans la version de travail du même site.
  const [sites, workingSums, versionSums, sessions] = await Promise.all([
    prisma.site.findMany({ select: { id: true, slug: true, thumbnailPath: true }, orderBy: { slug: "asc" } }),
    prisma.$queryRaw<Array<{ siteId: string; bytes: bigint | number | null }>>`
      SELECT siteId, SUM(size) AS bytes FROM (SELECT DISTINCT siteId, sha256, size FROM "WorkingFile") GROUP BY siteId`,
    prisma.$queryRaw<Array<{ siteId: string; bytes: bigint | number | null }>>`
      SELECT siteId, SUM(size) AS bytes FROM (
        SELECT DISTINCT v.siteId AS siteId, vf.sha256 AS sha256, vf.size AS size
        FROM "VersionFile" vf JOIN "Version" v ON v.id = vf.versionId
        WHERE v.status <> 'PURGED'
          AND NOT EXISTS (SELECT 1 FROM "WorkingFile" w WHERE w.siteId = v.siteId AND w.sha256 = vf.sha256)
      ) GROUP BY siteId`,
    uploadSessions(services.dataDir),
  ]);
  const workingBySite = new Map(workingSums.map((r) => [r.siteId, Number(r.bytes ?? 0)]));
  const versionsBySite = new Map(versionSums.map((r) => [r.siteId, Number(r.bytes ?? 0)]));
  const uploadsBySite = new Map<string, number>();
  for (const x of sessions) if (x.siteId) uploadsBySite.set(x.siteId, (uploadsBySite.get(x.siteId) ?? 0) + x.bytes);
  const perSite = await Promise.all(
    sites.map(async (s) => {
      const thumbnailBytes = s.thumbnailPath ? ((await stat(path.join(services.dataDir, s.thumbnailPath)).catch(() => null))?.size ?? 0) : 0;
      const workingBytes = workingBySite.get(s.id) ?? 0;
      const versionsBytes = versionsBySite.get(s.id) ?? 0;
      const uploadsBytes = uploadsBySite.get(s.id) ?? 0;
      return { siteId: s.id, slug: s.slug, workingBytes, versionsBytes, thumbnailBytes, uploadsBytes, totalBytes: workingBytes + versionsBytes + thumbnailBytes + uploadsBytes };
    }),
  );
  const blobs = await services.blobs.scan({ remove: false, graceMs: services.blobs.recentGraceMs });
  const thumbnails = await dirSize(path.join(services.dataDir, "thumbnails"));
  const temp = [await dirSize(path.join(services.dataDir, "tmp")), await dirSize(path.join(services.blobs.dir, "tmp"))];
  const uploadsBytes = sessions.reduce((a, x) => a + x.bytes, 0);
  const tempBytes = temp.reduce((a, t) => a + t.bytes, 0);
  const value: StorageUsage = {
    sites: perSite,
    total: {
      blobsBytes: blobs.totalBytes,
      orphanBytes: blobs.orphanBytes,
      thumbnailsBytes: thumbnails.bytes,
      uploadsBytes,
      tempBytes,
      totalBytes: blobs.totalBytes + thumbnails.bytes + uploadsBytes + tempBytes,
    },
  };
  usageCache = { at: Date.now(), dataDir: services.dataDir, value };
  return value;
}

// --- Cache du hub ---

async function removeOld(dir: string, graceMs: number): Promise<PurgeCount> {
  const out: PurgeCount = { count: 0, bytes: 0 };
  const now = Date.now();
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, e.name);
    const info = await stat(full).catch(() => null);
    if (!info || now - info.mtimeMs < graceMs) continue;
    const size = e.isDirectory() ? (await dirSize(full)).bytes : info.size;
    await rm(full, { recursive: true, force: true });
    out.count++;
    out.bytes += size;
  }
  return out;
}

/**
 * Purge du cache du hub. Sessions d'envoi (même en cours) d'un site ou de toutes ; temporaires et blobs
 * orphelins (toujours globaux, en épargnant ce qui a moins de quelques minutes) ; vignettes capturées
 * (régénérables : une image envoyée à la main n'est jamais supprimée).
 */
export async function purgeHubCache(services: Services, input: HubCachePurgeInput): Promise<HubCachePurgeResult> {
  const result: HubCachePurgeResult = { freedBytes: 0, uploads: null, uploadsSkipped: 0, temp: null, thumbnails: null, orphans: null };
  if (input.uploads) {
    const sessions = (await uploadSessions(services.dataDir)).filter((s) => !input.siteId || s.siteId === input.siteId);
    result.uploads = { count: 0, bytes: 0 };
    for (const s of sessions) {
      // Session en cours d'écriture, d'assemblage ou d'import : jamais supprimée, comptée à part.
      if (isUploadSessionBusy(path.basename(s.dir))) {
        result.uploadsSkipped++;
        continue;
      }
      await rm(s.dir, { recursive: true, force: true });
      result.uploads.count++;
      result.uploads.bytes += s.bytes;
    }
  }
  if (input.temp && !input.siteId) {
    const a = await removeOld(path.join(services.dataDir, "tmp"), TEMP_GRACE_MS);
    const b = await removeOld(path.join(services.blobs.dir, "tmp"), TEMP_GRACE_MS);
    result.temp = { count: a.count + b.count, bytes: a.bytes + b.bytes };
  }
  if (input.thumbnails) {
    const sites = await prisma.site.findMany({
      where: { thumbnailSource: "capture", thumbnailPath: { not: null }, ...(input.siteId ? { id: input.siteId } : {}) },
      select: { id: true, thumbnailPath: true },
    });
    result.thumbnails = { count: 0, bytes: 0 };
    for (const s of sites) {
      const file = path.join(services.dataDir, s.thumbnailPath!);
      const size = (await stat(file).catch(() => null))?.size ?? 0;
      await rm(file, { force: true });
      await prisma.site.update({ where: { id: s.id }, data: { thumbnailPath: null, thumbnailSource: null, thumbnailAt: null } });
      result.thumbnails.count++;
      result.thumbnails.bytes += size;
    }
  }
  if (input.orphans && !input.siteId) {
    const scan = await services.blobs.scan({ remove: true, graceMs: services.blobs.recentGraceMs });
    result.orphans = { count: scan.orphanCount, bytes: scan.orphanBytes };
  }
  invalidateStorageUsage();
  result.freedBytes = [result.uploads, result.temp, result.thumbnails, result.orphans].reduce((a, c) => a + (c?.bytes ?? 0), 0);
  return result;
}

// --- Cache Cloudflare du sous-domaine ---

const FILES_BATCH = 100;

/** URL publiques d'une version : chaque fichier, et la forme « dossier/ » des index.html. */
export function versionUrls(host: string, paths: string[]): string[] {
  const urls = new Set<string>();
  for (const p of paths) {
    const encoded = p.split("/").map(encodeURIComponent).join("/");
    urls.add(`https://${host}/${encoded}`);
    if (p === "index.html") urls.add(`https://${host}/`);
    else if (p.endsWith("/index.html")) urls.add(`https://${host}/${encoded.slice(0, -"index.html".length)}`);
  }
  return [...urls];
}

/**
 * Purge par nom d'hôte (le sous-domaine, et le domaine final seulement s'il est dans la zone du hub),
 * repli par URL en lots de 100 si Cloudflare refuse la purge par nom d'hôte. Limite de débit en cours de
 * route : arrêt propre, rapport de ce qui a été purgé.
 */
export async function purgeCloudflareCache(services: Services, siteId: string): Promise<CachePurgeResult> {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
  const hosts = [hostnameOf(site.slug, services.sitesDomain)];
  const skippedHosts: string[] = [];
  if (site.finalDomain) {
    const finals = [finalHost(site.finalDomain, site.canonicalHost), finalHost(site.finalDomain, site.canonicalHost === "apex" ? "www" : "apex")];
    // Seulement dans la zone du hub, et jamais la zone, www, hub, erp, api ni l'adresse d'un autre site :
    // un conflit sur l'une des deux formes écarte le domaine final entier.
    let conflict = false;
    for (const h of finals) if (await hubZoneConflict(h, services.sitesDomain, siteId)) conflict = true;
    for (const h of finals) {
      const inZone = h === services.sitesDomain || h.endsWith(`.${services.sitesDomain}`);
      if (inZone && !conflict && !hosts.includes(h)) hosts.push(h);
      else skippedHosts.push(h);
    }
  }
  const finish = async (r: CachePurgeResult) => {
    await audit({ action: "cache.cloudflare.purge", result: r.complete ? "ok" : "error", siteId, siteSlug: site.slug, detail: `${r.method} : ${r.message}` });
    return r;
  };
  try {
    await services.cloudflare.purgeCache({ hosts });
    return finish({ method: "hosts", hosts, skippedHosts, urlsPurged: 0, urlsTotal: 0, complete: true, message: `Cache purgé pour ${hosts.join(", ")}.` });
  } catch (err) {
    const refused = err instanceof CloudflareError && err.cfCode !== CF_PURGE_RATE_LIMITED && err.status !== 403 && (err.cfCode === CF_PURGE_REFUSED || err.status === 400);
    if (!refused) throw toHttp(err);
  }
  const files = site.currentVersionId ? await prisma.versionFile.findMany({ where: { versionId: site.currentVersionId }, select: { path: true } }) : [];
  const urls = hosts.flatMap((h) => versionUrls(h, files.map((f) => f.path)));
  let purged = 0;
  for (let i = 0; i < urls.length; i += FILES_BATCH) {
    const batch = urls.slice(i, i + FILES_BATCH);
    try {
      await services.cloudflare.purgeCache({ files: batch });
      purged += batch.length;
    } catch (err) {
      if (err instanceof CloudflareError && err.cfCode === CF_PURGE_RATE_LIMITED) {
        return finish({
          method: "files",
          hosts,
          skippedHosts,
          urlsPurged: purged,
          urlsTotal: urls.length,
          complete: false,
          message: `${purged} adresse(s) purgée(s) sur ${urls.length} : limite de Cloudflare atteinte (5 purges par minute), relancez dans une minute.`,
        });
      }
      throw toHttp(err);
    }
  }
  return finish({ method: "files", hosts, skippedHosts, urlsPurged: purged, urlsTotal: urls.length, complete: true, message: `Purge par nom d'hôte refusée : ${purged} adresse(s) purgée(s) une à une.` });
}

function toHttp(err: unknown): Error {
  if (!(err instanceof CloudflareError)) return err instanceof Error ? err : new Error("purge impossible");
  if (err.status === 403) return new HttpError(403, err.message, "cf_permission");
  if (err.cfCode === CF_PURGE_RATE_LIMITED) return new HttpError(409, err.message, "cf_rate_limited");
  return new HttpError(502, err.message, "cf_error");
}
