import type { Version } from "@prisma/client";
import type { FileRef } from "@/lib/files.js";
import { refreshDirty } from "@/lib/files.js";
import { HttpError } from "@/lib/http.js";
import { KEPT_VERSIONS } from "@/lib/limits.js";
import { prisma } from "@/lib/prisma.js";
import { classifySitePath, CONFIG_FILES } from "@/lib/site-paths.js";
import { siteExtras } from "@/lib/site-extras.js";
import { buildWorkerScript } from "@/lib/worker-script.js";
import { HTACCESS_PATH, pagesDeployConfig } from "@/lib/server-config.js";
import { profileOf } from "@/lib/server-config-store.js";
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
  // index.html absent ou projet non construit : refusé avant, par le contrôle de la version (sauf « Publier quand même »).
  if (files.length === 0) throw new HttpError(400, "Publication impossible : aucun fichier de travail.", "no_files");
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
 * Déploiements Cloudflare créés pendant la fenêtre de la version (depuis sa création) et inconnus du hub :
 * restes d'une tentative dont la réponse s'est perdue (délai dépassé après création, appel rejoué).
 * L'API ne renvoie pas le manifeste : on rattache le plus récent de la fenêtre, une seule publication
 * tournant à la fois par site ; les autres sont supprimés, jamais celui servi.
 */
async function strayDeployments(services: Services, site: { id: string; pagesProject: string }, since: Date) {
  const known = new Set(
    (await prisma.version.findMany({ where: { siteId: site.id, cfDeploymentId: { not: null } }, select: { cfDeploymentId: true } })).map(
      (v) => v.cfDeploymentId!,
    ),
  );
  const list = await services.cloudflare.listDeployments(site.pagesProject);
  return list
    .filter((d) => !known.has(d.id) && Date.parse(d.createdOn) >= since.getTime())
    .sort((a, b) => Date.parse(b.createdOn) - Date.parse(a.createdOn));
}

/** Début de la fenêtre : création de la version, moins une marge pour un écart d'horloge avec Cloudflare. */
const windowStart = (createdAt: Date) => new Date(createdAt.getTime() - 60_000);

async function deleteStrays(services: Services, project: string, ids: string[]): Promise<void> {
  for (const id of ids) await services.cloudflare.deleteDeployment(project, id).catch(() => undefined);
}

async function markPublished(siteId: string, versionId: string, deployment: { id: string; url: string }): Promise<void> {
  const now = new Date();
  await prisma.version.update({
    where: { id: versionId },
    data: { status: "PUBLISHED", cfDeploymentId: deployment.id, cfDeploymentUrl: deployment.url || null, publishedAt: now, error: null },
  });
  await prisma.site.update({ where: { id: siteId }, data: { currentVersionId: versionId, touchedAt: now } });
  await refreshDirty(siteId);
}

/**
 * Envoie une version à Cloudflare et la rend servie. Rejouable : une version déjà déployée n'est pas
 * renvoyée, et un déploiement créé par une tentative précédente sans réponse est rattaché au lieu d'en
 * créer un second. _headers et _redirects partent comme champs dédiés, jamais comme fichiers servis.
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
  // Reprise : un déploiement de la fenêtre de cette version existe déjà chez Cloudflare.
  const strays = await strayDeployments(services, site, windowStart(version.createdAt));
  if (strays.length > 0) {
    const [adopted, ...rest] = strays;
    await markPublished(siteId, versionId, adopted!);
    await deleteStrays(services, site.pagesProject, rest.map((d) => d.id));
    return;
  }
  await prisma.version.update({ where: { id: versionId }, data: { status: "UPLOADING", error: null } });

  const files: DeployFile[] = [];
  const user: { headers?: string; redirects?: string } = {};
  const extras = await siteExtras(siteId);
  for (const f of version.files) {
    // Fichier de développement resté dans une version (envoi d'avant la règle) : jamais déployé.
    if (!CONFIG_FILES.has(f.path) && f.path !== HTACCESS_PATH && classifySitePath(f.path, { allow: extras.devFilesAllowed }).action !== "accept") continue;
    if (CONFIG_FILES.has(f.path)) {
      const text = (await services.blobs.read(f.sha256)).toString("utf8");
      if (f.path === "_headers") user.headers = text;
      else user.redirects = text;
      continue;
    }
    // .htaccess : configuration de l'hébergement final, sans effet sur Pages, jamais envoyé.
    if (f.path === HTACCESS_PATH) continue;
    files.push({ path: f.path, sha256: f.sha256, size: f.size, read: () => services.blobs.read(f.sha256) });
  }
  const config = pagesDeployConfig(profileOf(site), new Set(version.files.map((f) => f.path)), user);
  const notFound = config.notFoundCopyFrom ? files.find((f) => f.path === config.notFoundCopyFrom) : undefined;
  if (notFound) files.push({ ...notFound, path: "404.html" });

  try {
    const deployment = await services.cloudflare.deploy(site.pagesProject, {
      files,
      workerJs: buildWorkerScript(hostnameOf(site.slug, services.sitesDomain), {
        cacheRules: config.cacheRules,
        allow: extras.devFilesAllowed,
        csp: extras.siteCsp,
        has404: files.some((f) => f.path === "404.html"),
      }),
      ...(config.headersFile !== undefined ? { headersFile: config.headersFile } : {}),
      ...(config.redirectsFile !== undefined ? { redirectsFile: config.redirectsFile } : {}),
    });
    await markPublished(siteId, versionId, deployment);
    // Appel rejoué après une coupure : d'autres déploiements de la fenêtre peuvent exister, supprimés.
    const extra = await strayDeployments(services, site, windowStart(version.createdAt)).catch(() => []);
    await deleteStrays(services, site.pagesProject, extra.map((d) => d.id));
  } catch (err) {
    await prisma.version.update({
      where: { id: versionId },
      data: { status: "FAILED", error: (err instanceof Error ? err.message : "Échec de l'envoi").slice(0, 500) },
    });
    throw err;
  }
}

/**
 * Rétention : les KEPT_VERSIONS versions de contenu publiées les plus récentes et la version servie
 * restent ; les autres (versions en échec et pages d'attente qui ne sont plus servies comprises)
 * perdent leur déploiement Cloudflare et leurs fichiers (statut PURGED). Renvoie le nombre de versions
 * purgées et les échecs éventuels.
 */
export async function applyRetention(services: Services, siteId: string): Promise<{ purged: number; failed: number }> {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
  const versions = await prisma.version.findMany({
    where: { siteId, status: { in: ["PUBLISHED", "FAILED"] } },
    orderBy: { number: "desc" },
  });
  // Seules les versions publiées comptent dans les 10 gardées ; une version en échec est purgée à part.
  const keep = new Set(
    versions
      .filter((v) => v.source !== "placeholder" && v.status === "PUBLISHED")
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
