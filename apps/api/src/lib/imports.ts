import type { RejectedFile, UploadResult, VersionCheck } from "@/contract.js";
import { siteExtras } from "@/lib/site-extras.js";
import { checkVersion } from "@/lib/version-check.js";
import { audit } from "@/lib/audit.js";
import { replaceWorkingFiles } from "@/lib/maintenance.js";
import { prisma } from "@/lib/prisma.js";
import { HTACCESS_PATH } from "@/lib/server-config.js";
import { applyWorkingChanges, listFiles, splitCaseConflicts, workingPaths, type FileRef } from "@/lib/files.js";
import { HttpError } from "@/lib/http.js";
import type { Services } from "@/lib/services.js";
import { extractZip } from "@/lib/zip.js";

/**
 * Écriture des fichiers reçus dans la version de travail : mêmes contrôles pour l'envoi direct et pour
 * l'envoi par morceaux (conflits de casse, plafonds du site, tout ou rien).
 */
/**
 * Projet reconnu sur tout l'envoi, fichiers écartés compris : package.json et astro.config ne sont plus gardés,
 * mais ils signent un projet non construit. Seulement « unbuilt » (le reste se lit sur la version de travail).
 */
function projectCheckOf(accepted: string[], rejected: string[]): VersionCheck | null {
  const check = checkVersion([...accepted, ...rejected], null);
  return check?.code === "unbuilt" ? check : null;
}

/**
 * « Remplacer tout le contenu » : la version de travail devient exactement l'envoi, par la même purge que
 * « Vider les fichiers ». Le .htaccess généré par le hub (non modifié) est gardé si l'envoi n'en apporte pas.
 */
async function replaceWith(services: Services, siteId: string, files: FileRef[]): Promise<number> {
  const upserts = [...files];
  if (!upserts.some((f) => f.path === HTACCESS_PATH)) {
    const [site, current] = await Promise.all([
      prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { serverConfigHash: true } }),
      prisma.workingFile.findUnique({ where: { siteId_path: { siteId, path: HTACCESS_PATH } }, select: { path: true, sha256: true, size: true } }),
    ]);
    if (current && current.sha256 === site.serverConfigHash) upserts.push(current);
  }
  return (await replaceWorkingFiles(services, siteId, upserts)).removed;
}

export async function importFiles(
  services: Services,
  site: { id: string; slug: string },
  stored: FileRef[],
  rejected: RejectedFile[],
  mode: "replace" | "merge" = "merge",
): Promise<UploadResult> {
  // Remplacer : rien d'existant ne reste, donc aucun conflit de casse avec l'existant (ceux de l'envoi sont écartés à l'ouverture).
  const { kept, rejected: conflicts } = mode === "replace" ? { kept: stored, rejected: [] } : splitCaseConflicts(stored, await workingPaths(site.id));
  const allRejected = [...rejected, ...conflicts];
  let removed = 0;
  if (kept.length > 0) {
    if (mode === "replace") removed = await replaceWith(services, site.id, kept);
    else await applyWorkingChanges(site.id, { upserts: kept });
    await audit({
      action: "files.upload",
      result: "ok",
      siteId: site.id,
      siteSlug: site.slug,
      detail: mode === "replace" ? `${kept.length} fichier(s), contenu remplacé, ${removed} retiré(s)` : `${kept.length} fichier(s)`,
    });
  }
  return {
    accepted: kept.map((f) => f.path),
    rejected: allRejected,
    ...(mode === "replace" ? { removed } : {}),
    projectCheck: projectCheckOf(
      kept.map((f) => f.path),
      allRejected.map((r) => r.path),
    ),
    files: await listFiles(site.id, services.blobs),
  };
}

/** Zip déjà écrit sur le disque : extraction contrôlée (chemins, bombes, interdits) puis écriture, tout ou rien. */
export async function importZip(
  services: Services,
  site: { id: string; slug: string },
  zipPath: string,
  mode: "replace" | "merge",
): Promise<UploadResult> {
  try {
    const extraction = await extractZip(zipPath, services.blobs, undefined, (await siteExtras(site.id)).devFilesAllowed);
    if (mode === "merge") {
      const { kept, rejected: conflicts } = splitCaseConflicts(extraction.accepted, await workingPaths(site.id));
      extraction.accepted = kept;
      extraction.rejected.push(...conflicts);
    }
    let removed = 0;
    if (extraction.accepted.length > 0) {
      if (mode === "replace") removed = await replaceWith(services, site.id, extraction.accepted);
      else await applyWorkingChanges(site.id, { upserts: extraction.accepted });
      await audit({
        action: "files.zip",
        result: "ok",
        siteId: site.id,
        siteSlug: site.slug,
        detail: `${extraction.accepted.length} fichier(s), mode ${mode}${mode === "replace" ? `, ${removed} retiré(s)` : ""}`,
      });
    }
    return {
      accepted: extraction.accepted.map((f) => f.path),
      rejected: extraction.rejected,
      projectCheck: projectCheckOf(extraction.accepted.map((f) => f.path), extraction.rejected.map((r) => r.path)),
      strippedRoot: extraction.strippedRoot,
      ...(mode === "replace" ? { removed } : {}),
      files: await listFiles(site.id, services.blobs),
    };
  } catch (err) {
    if (err instanceof HttpError) {
      await audit({ action: "files.zip", result: "error", siteId: site.id, siteSlug: site.slug, detail: err.message });
    }
    throw err;
  }
}
