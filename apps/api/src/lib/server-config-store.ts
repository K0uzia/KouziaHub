import type { Site } from "@prisma/client";
import type { ServerConfigState } from "@/contract.js";
import { audit } from "@/lib/audit.js";
import type { BlobStore } from "@/lib/blobs.js";
import { applyWorkingChanges } from "@/lib/files.js";
import { prisma } from "@/lib/prisma.js";
import { buildHtaccess, HTACCESS_PATH, type ServerProfile } from "@/lib/server-config.js";

export function profileOf(site: Pick<Site, "finalDomain" | "canonicalHost" | "notFoundPage">): ServerProfile {
  return {
    finalDomain: site.finalDomain,
    canonicalHost: site.canonicalHost === "apex" ? "apex" : "www",
    notFoundPage: site.notFoundPage,
  };
}

/**
 * État du .htaccess de la version de travail : « generated » s'il porte l'empreinte du dernier écrit
 * par le hub, « modified » s'il a changé (main, zip), « missing » s'il est absent.
 */
export async function serverConfigState(site: Site): Promise<ServerConfigState> {
  const [file, notFound] = await Promise.all([
    prisma.workingFile.findUnique({ where: { siteId_path: { siteId: site.id, path: HTACCESS_PATH } }, select: { sha256: true } }),
    prisma.workingFile.findUnique({ where: { siteId_path: { siteId: site.id, path: site.notFoundPage.slice(1) } }, select: { id: true } }),
  ]);
  const status = !file ? "missing" : file.sha256 === site.serverConfigHash ? "generated" : "modified";
  return {
    status,
    path: HTACCESS_PATH,
    generatedAt: site.serverConfigAt?.toISOString() ?? null,
    notFoundPagePresent: notFound !== null,
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
  const blob = await blobs.putBuffer(Buffer.from(buildHtaccess(profileOf(site)), "utf8"));
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
