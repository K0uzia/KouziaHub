import type { RejectedFile, UploadResult } from "@/contract.js";
import type { BlobStore } from "@/lib/blobs.js";
import { audit } from "@/lib/audit.js";
import { applyWorkingChanges, listFiles, splitCaseConflicts, workingPaths, type FileRef } from "@/lib/files.js";
import { HttpError } from "@/lib/http.js";
import type { Services } from "@/lib/services.js";
import { extractZip } from "@/lib/zip.js";

/**
 * Écriture des fichiers reçus dans la version de travail : mêmes contrôles pour l'envoi direct et pour
 * l'envoi par morceaux (conflits de casse, plafonds du site, tout ou rien).
 */
export async function importFiles(
  blobs: BlobStore,
  site: { id: string; slug: string },
  stored: FileRef[],
  rejected: RejectedFile[],
): Promise<UploadResult> {
  const { kept, rejected: conflicts } = splitCaseConflicts(stored, await workingPaths(site.id));
  const allRejected = [...rejected, ...conflicts];
  if (kept.length > 0) {
    await applyWorkingChanges(site.id, { upserts: kept });
    await audit({ action: "files.upload", result: "ok", siteId: site.id, siteSlug: site.slug, detail: `${kept.length} fichier(s)` });
  }
  return { accepted: kept.map((f) => f.path), rejected: allRejected, files: await listFiles(site.id, blobs) };
}

/** Zip déjà écrit sur le disque : extraction contrôlée (chemins, bombes, interdits) puis écriture, tout ou rien. */
export async function importZip(
  services: Services,
  site: { id: string; slug: string },
  zipPath: string,
  mode: "replace" | "merge",
): Promise<UploadResult> {
  try {
    const extraction = await extractZip(zipPath, services.blobs);
    if (mode === "merge") {
      const { kept, rejected: conflicts } = splitCaseConflicts(extraction.accepted, await workingPaths(site.id));
      extraction.accepted = kept;
      extraction.rejected.push(...conflicts);
    }
    if (extraction.accepted.length > 0) {
      await applyWorkingChanges(site.id, { upserts: extraction.accepted, replaceAll: mode === "replace" });
      await audit({
        action: "files.zip",
        result: "ok",
        siteId: site.id,
        siteSlug: site.slug,
        detail: `${extraction.accepted.length} fichier(s), mode ${mode}`,
      });
      if (mode === "replace") void services.blobs.gc().catch(() => undefined);
    }
    return {
      accepted: extraction.accepted.map((f) => f.path),
      rejected: extraction.rejected,
      strippedRoot: extraction.strippedRoot,
      files: await listFiles(site.id, services.blobs),
    };
  } catch (err) {
    if (err instanceof HttpError) {
      await audit({ action: "files.zip", result: "error", siteId: site.id, siteSlug: site.slug, detail: err.message });
    }
    throw err;
  }
}
