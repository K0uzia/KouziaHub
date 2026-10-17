import type { Version } from "@prisma/client";
import type { FileRef } from "@/lib/files.js";
import { refreshDirty } from "@/lib/files.js";
import { HttpError } from "@/lib/http.js";
import { KEPT_VERSIONS } from "@/lib/limits.js";
import { prisma } from "@/lib/prisma.js";
import { CONFIG_FILES } from "@/lib/site-paths.js";
import { buildWorkerScript } from "@/lib/worker-script.js";
import type { Services } from "@/lib/services.js";
import type { DeployFile } from "@/lib/cloudflare/types.js";

export type VersionSource = "files" | "zip" | "placeholder" | "republish";

export const hostnameOf = (slug: string, sitesDomain: string) => `${slug}.${sitesDomain}`;

/** Nouvelle version (numéro suivant du site) avec l'instantané de ses fichiers. */
export async function createVersion(
  siteId: string,
  source: VersionSource,
  files: FileRef[],
  options: { note?: string | null; sourceVersionId?: string | null } = {},
): Promise<Version> {
  return prisma.$transaction(
    async (tx) => {
      const last = await tx.version.findFirst({ where: { siteId }, orderBy: { number: "desc" }, select: { number: true } });
      const version = await tx.version.create({
        data: {
          siteId,
          number: (last?.number ?? 0) + 1,
          source,
          note: options.note ?? null,
          sourceVersionId: options.sourceVersionId ?? null,
          fileCount: files.length,
          totalBytes: files.reduce((s, f) => s + f.size, 0),
          status: "UPLOADING",
        },
      });
      for (let i = 0; i < files.length; i += 400) {
        await tx.versionFile.createMany({
          data: files.slice(i, i + 400).map((f) => ({ versionId: version.id, path: f.path, sha256: f.sha256, size: f.size })),
        });
      }
      return version;
    },
    { timeout: 120_000 },
  );
}

/** Origine des fichiers de travail : « zip » si le dernier changement venait d'un zip. */
export async function workingSource(siteId: string): Promise<"files" | "zip"> {
  const last = await prisma.auditEvent.findFirst({
    where: { siteId, result: "ok", action: { in: ["files.upload", "files.delete", "files.move", "files.zip", "files.restore"] } },
    orderBy: { at: "desc" },
    select: { action: true },
  });
  return last?.action === "files.zip" ? "zip" : "files";
}

/** Instantané de la version de travail, au moment du clic (les modifications suivantes n'y entrent pas). */
export async function snapshotWorking(siteId: string, note: string | null): Promise<Version> {
  const files = await prisma.workingFile.findMany({ where: { siteId }, select: { path: true, sha256: true, size: true } });
  if (!files.some((f) => f.path === "index.html")) {
    throw new HttpError(400, "Publication impossible : il manque index.html à la racine.", "no_index");
  }
  return createVersion(siteId, await workingSource(siteId), files, { note });
}

/** Copie d'une version gardée, pour la republier. */
export async function snapshotVersion(siteId: string, versionId: string): Promise<Version> {
  const source = await prisma.version.findFirst({ where: { id: versionId, siteId }, include: { files: true } });
  if (!source) throw new HttpError(404, "Version introuvable.");
  if (source.status === "PURGED") throw new HttpError(409, "Version purgée : ses fichiers ne sont plus gardés.");
  if (source.status === "UPLOADING") throw new HttpError(409, "Version en cours d'envoi.");
  if (!source.files.some((f) => f.path === "index.html")) {
    throw new HttpError(400, "Publication impossible : il manque index.html à la racine.", "no_index");
  }
  return createVersion(
    siteId,
    "republish",
    source.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })),
    { note: source.note, sourceVersionId: source.id },
  );
}

/**
 * Envoie une version à Cloudflare et la rend servie. Rejouable : une version déjà déployée n'est pas
 * renvoyée. _headers et _redirects partent comme champs dédiés, jamais comme fichiers servis.
 */
export async function deployVersion(services: Services, siteId: string, versionId: string): Promise<void> {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
  const version = await prisma.version.findFirstOrThrow({ where: { id: versionId, siteId }, include: { files: true } });
  if (version.status === "PURGED") throw new HttpError(409, "Version purgée : ses fichiers ne sont plus gardés.");
  if (version.status === "PUBLISHED" && version.cfDeploymentId) {
    await prisma.site.update({ where: { id: siteId }, data: { currentVersionId: version.id } });
    await refreshDirty(siteId);
    return;
  }
  await prisma.version.update({ where: { id: versionId }, data: { status: "UPLOADING", error: null } });

  const files: DeployFile[] = [];
  let headersFile: string | undefined;
  let redirectsFile: string | undefined;
  for (const f of version.files) {
    if (CONFIG_FILES.has(f.path)) {
      const text = (await services.blobs.read(f.sha256)).toString("utf8");
      if (f.path === "_headers") headersFile = text;
      else redirectsFile = text;
      continue;
    }
    files.push({ path: f.path, sha256: f.sha256, size: f.size, read: () => services.blobs.read(f.sha256) });
  }

  try {
    const deployment = await services.cloudflare.deploy(site.pagesProject, {
      files,
      workerJs: buildWorkerScript(hostnameOf(site.slug, services.sitesDomain)),
      ...(headersFile !== undefined ? { headersFile } : {}),
      ...(redirectsFile !== undefined ? { redirectsFile } : {}),
    });
    const now = new Date();
    await prisma.version.update({
      where: { id: versionId },
      data: { status: "PUBLISHED", cfDeploymentId: deployment.id, cfDeploymentUrl: deployment.url || null, publishedAt: now, error: null },
    });
    await prisma.site.update({ where: { id: siteId }, data: { currentVersionId: versionId, touchedAt: now } });
    await refreshDirty(siteId);
  } catch (err) {
    await prisma.version.update({
      where: { id: versionId },
      data: { status: "FAILED", error: (err instanceof Error ? err.message : "Échec de l'envoi").slice(0, 500) },
    });
    throw err;
  }
}

/**
 * Rétention : les KEPT_VERSIONS versions de contenu les plus récentes et la version servie restent ;
 * les autres (et les pages d'attente qui ne sont plus servies) perdent leur déploiement Cloudflare et
 * leurs fichiers (statut PURGED). Renvoie le nombre de versions purgées et les échecs éventuels.
 */
export async function applyRetention(services: Services, siteId: string): Promise<{ purged: number; failed: number }> {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
  const versions = await prisma.version.findMany({
    where: { siteId, status: { in: ["PUBLISHED", "FAILED"] } },
    orderBy: { number: "desc" },
  });
  const keep = new Set(
    versions
      .filter((v) => v.source !== "placeholder")
      .slice(0, KEPT_VERSIONS)
      .map((v) => v.id),
  );
  if (site.currentVersionId) keep.add(site.currentVersionId);
  let purged = 0;
  let failed = 0;
  for (const v of versions) {
    if (keep.has(v.id)) continue;
    try {
      if (v.cfDeploymentId) await services.cloudflare.deleteDeployment(site.pagesProject, v.cfDeploymentId);
    } catch {
      failed++;
      continue;
    }
    await prisma.$transaction([
      prisma.versionFile.deleteMany({ where: { versionId: v.id } }),
      prisma.version.update({ where: { id: v.id }, data: { status: "PURGED", purgedAt: new Date() } }),
    ]);
    purged++;
  }
  if (purged > 0) void services.blobs.gc().catch(() => undefined);
  return { purged, failed };
}
