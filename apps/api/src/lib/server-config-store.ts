import type { Site } from "@prisma/client";
import type { ServerConfigState } from "@/contract.js";
import { audit } from "@/lib/audit.js";
import type { BlobStore } from "@/lib/blobs.js";
import { applyWorkingChanges } from "@/lib/files.js";
import { prisma } from "@/lib/prisma.js";
import { createHash } from "node:crypto";
import { siteExtras } from "@/lib/site-extras.js";
import { buildHtaccess, HTACCESS_PATH, siteContentOf, type ServerProfile } from "@/lib/server-config.js";

export function profileOf(site: Pick<Site, "finalDomain" | "canonicalHost" | "notFoundPage">): ServerProfile {
  return {
    finalDomain: site.finalDomain,
    canonicalHost: site.canonicalHost === "apex" ? "apex" : "www",
    notFoundPage: site.notFoundPage,
  };
}

/** .htaccess que le hub génère aujourd'hui pour la version de travail : profil du site et fichiers présents. */
export async function generatedHtaccess(site: Site): Promise<string> {
  const paths = (await prisma.workingFile.findMany({ where: { siteId: site.id }, select: { path: true } })).map((f) => f.path);
  return buildHtaccess(await fullProfileOf(site), siteContentOf(paths, site.notFoundPage));
}

/** Profil complet : profil du site, CSP et exceptions de l'onglet Serveur. */
export async function fullProfileOf(site: Site): Promise<ServerProfile> {
  const extras = await siteExtras(site.id);
  return { ...profileOf(site), csp: extras.siteCsp, allow: extras.devFilesAllowed, hosting: extras.hosting };
}

const sha256 = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/**
 * État du .htaccess de la version de travail : « generated » s'il porte l'empreinte du dernier écrit
 * par le hub, « modified » s'il a changé (main, zip), « missing » s'il est absent. « outdated » : ce que le
 * hub générerait aujourd'hui (nouvelle page 404, dossiers hashés, sitemap, profil) diffère du dernier écrit.
 */
export async function serverConfigState(site: Site): Promise<ServerConfigState> {
  const [file, notFound, text] = await Promise.all([
    prisma.workingFile.findUnique({ where: { siteId_path: { siteId: site.id, path: HTACCESS_PATH } }, select: { sha256: true } }),
    prisma.workingFile.findUnique({ where: { siteId_path: { siteId: site.id, path: site.notFoundPage.slice(1) } }, select: { id: true } }),
    generatedHtaccess(site),
  ]);
  const status = !file ? "missing" : file.sha256 === site.serverConfigHash ? "generated" : "modified";
  return {
    status,
    path: HTACCESS_PATH,
    generatedAt: site.serverConfigAt?.toISOString() ?? null,
    notFoundPagePresent: notFound !== null,
    outdated: status !== "missing" && site.serverConfigHash !== null && sha256(text) !== site.serverConfigHash,
  };
}

/**
 * Écrit le .htaccess généré dans la version de travail. Jamais d'écrasement silencieux : un fichier
 * modifié, remplacé ou supprimé depuis la dernière génération n'est réécrit qu'avec force.
 * Un site qui n'a encore rien reçu du hub (aucune empreinte, aucun fichier) est écrit sans force.
 */
export async function writeServerConfig(
  blobs: BlobStore,
  siteId: string,
  options: { force?: boolean; reason: string },
): Promise<{ written: boolean; state: ServerConfigState }> {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
  const before = await serverConfigState(site);
  const firstTime = site.serverConfigHash === null && before.status === "missing";
  if (!options.force && before.status !== "generated" && !firstTime) {
    await audit({
      action: "server-config.skip",
      result: "ok",
      siteId,
      siteSlug: site.slug,
      detail: `${options.reason} : .htaccess ${before.status === "modified" ? "modifié" : "supprimé"} à la main, non réécrit`,
    });
    return { written: false, state: before };
  }
  const blob = await blobs.putBuffer(Buffer.from(await generatedHtaccess(site), "utf8"));
  await applyWorkingChanges(siteId, { upserts: [{ path: HTACCESS_PATH, ...blob }] });
  const updated = await prisma.site.update({ where: { id: siteId }, data: { serverConfigHash: blob.sha256, serverConfigAt: new Date() } });
  await audit({
    action: "server-config.generate",
    result: "ok",
    siteId,
    siteSlug: site.slug,
    detail: options.force && before.status !== "generated" ? `${options.reason} (forcé)` : options.reason,
  });
  return { written: true, state: await serverConfigState(updated) };
}

/**
 * Avant une publication : un .htaccess généré (non modifié à la main) suit le contenu de la version (page 404,
 * dossiers hashés, sitemap). Modifié à la main, il n'est pas touché : l'onglet Serveur propose « régénérer ? ».
 */
export async function refreshServerConfigForPublish(blobs: BlobStore, siteId: string): Promise<void> {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
  const state = await serverConfigState(site);
  if (state.status === "generated" && state.outdated) await writeServerConfig(blobs, siteId, { reason: "publication : contenu du site changé" });
}
