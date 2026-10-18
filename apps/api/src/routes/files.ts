import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { audit } from "@/lib/audit.js";
import { requireAuth } from "@/lib/auth.js";
import { applyWorkingChanges, CASE_CONFLICT, listFiles, type FileRef } from "@/lib/files.js";
import { HttpError } from "@/lib/http.js";
import { idParams } from "@/lib/http-input.js";
import { MAX_FILES_PER_UPLOAD } from "@/lib/limits.js";
import { prisma } from "@/lib/prisma.js";
import type { Services } from "@/lib/services.js";
import { checkSitePath, normalizeSitePath } from "@/lib/site-paths.js";

const rawQuery = z.object({ path: z.string().min(1).max(2000) });
const deleteSchema = z.object({ paths: z.array(z.string().min(1).max(2000)).min(1).max(MAX_FILES_PER_UPLOAD) });
const moveSchema = z.object({ from: z.string().min(1).max(2000), to: z.string().min(1).max(2000) });

async function loadSite(id: string) {
  const site = await prisma.site.findUnique({ where: { id } });
  if (!site) throw new HttpError(404, "Site introuvable.");
  if (site.state === "DELETING") throw new HttpError(409, "Suppression en cours.");
  return site;
}

/** Chemin exact, ou dossier (terminé par « / ») ; null si invalide. */
function parseTarget(raw: string): { kind: "file" | "dir"; path: string } | { error: string } {
  const isDir = raw.endsWith("/");
  const result = normalizeSitePath(isDir ? raw.replace(/\/+$/, "") : raw);
  if (!result.ok) return { error: result.reason };
  return { kind: isDir ? "dir" : "file", path: result.path };
}

/** En-tête de téléchargement : nom ASCII de repli puis nom UTF-8 (RFC 6266). */
function contentDisposition(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const ascii = base.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

export function filesRoutes(services: Services): FastifyPluginAsync {
  return async (app) => {
    app.addHook("onRequest", requireAuth);

    app.get("/api/sites/:id/files", async (request) => {
      const { id } = idParams.parse(request.params);
      const site = await prisma.site.findUnique({ where: { id }, select: { id: true } });
      if (!site) throw new HttpError(404, "Site introuvable.");
      return listFiles(id);
    });

    // Téléchargement seulement : jamais servi en ligne sur l'origine du hub (un HTML envoyé y exécuterait du script).
    app.get("/api/sites/:id/files/raw", async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const parsed = rawQuery.safeParse(request.query);
      if (!parsed.success) throw new HttpError(400, "Chemin attendu.");
      const target = normalizeSitePath(parsed.data.path);
      if (!target.ok) throw new HttpError(400, target.reason);
      const file = await prisma.workingFile.findUnique({ where: { siteId_path: { siteId: id, path: target.path } } });
      if (!file) throw new HttpError(404, "Fichier introuvable.");
      return reply
        .header("Content-Type", "application/octet-stream")
        .header("Content-Disposition", contentDisposition(file.path))
        .header("Content-Length", String(file.size))
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .send(services.blobs.stream(file.sha256));
    });

    // Envoi de fichiers et de zips : uniquement par les sessions (routes/uploads.ts), seul chemin d'entrée.
    // Les anciennes routes multipart POST /api/sites/:id/files et /zip sont retirées.

    app.post("/api/sites/:id/files/delete", async (request) => {
      const { id } = idParams.parse(request.params);
      const site = await loadSite(id);
      const parsed = deleteSchema.safeParse(request.body);
      if (!parsed.success) throw new HttpError(400, "Liste de chemins attendue.");
      const deletePaths: string[] = [];
      const deletePrefixes: string[] = [];
      for (const raw of parsed.data.paths) {
        const target = parseTarget(raw);
        if ("error" in target) throw new HttpError(400, `${raw.slice(0, 200)} : ${target.error}`);
        if (target.kind === "dir") deletePrefixes.push(`${target.path}/`);
        else deletePaths.push(target.path);
      }
      await applyWorkingChanges(id, { deletePaths, deletePrefixes });
      await audit({ action: "files.delete", result: "ok", siteId: id, siteSlug: site.slug, detail: `${parsed.data.paths.length} élément(s)` });
      void services.blobs.gc().catch(() => undefined);
      return listFiles(id);
    });

    app.post("/api/sites/:id/files/move", async (request) => {
      const { id } = idParams.parse(request.params);
      const site = await loadSite(id);
      const parsed = moveSchema.safeParse(request.body);
      if (!parsed.success) throw new HttpError(400, "Chemins « from » et « to » attendus.");
      const from = parseTarget(parsed.data.from);
      if ("error" in from) throw new HttpError(400, `Origine invalide : ${from.error}`);
      const toRaw = from.kind === "dir" ? parsed.data.to.replace(/\/+$/, "") : parsed.data.to;
      const to = normalizeSitePath(toRaw);
      if (!to.ok) throw new HttpError(400, `Destination invalide : ${to.reason}`);
      if (to.path === from.path) return listFiles(id);

      const all = await prisma.workingFile.findMany({ where: { siteId: id }, select: { path: true, sha256: true, size: true } });
      const moving =
        from.kind === "dir" ? all.filter((f) => f.path.startsWith(`${from.path}/`)) : all.filter((f) => f.path === from.path);
      if (moving.length === 0) throw new HttpError(404, from.kind === "dir" ? "Dossier introuvable." : "Fichier introuvable.");
      if (from.kind === "dir" && (to.path + "/").startsWith(`${from.path}/`)) {
        throw new HttpError(400, "Un dossier ne peut pas être déplacé dans lui-même.");
      }
      const movingPaths = new Set(moving.map((f) => f.path));
      const existing = new Set(all.filter((f) => !movingPaths.has(f.path)).map((f) => f.path));
      const existingLower = new Map([...existing].map((p) => [p.toLowerCase(), p]));
      const upserts: FileRef[] = [];
      for (const f of moving) {
        const next = from.kind === "dir" ? `${to.path}/${f.path.slice(from.path.length + 1)}` : to.path;
        const { path: target, verdict } = checkSitePath(next);
        if (verdict.action !== "accept") throw new HttpError(400, `${target.slice(0, 200)} : ${verdict.reason}`);
        if (existing.has(target)) throw new HttpError(409, `Un fichier porte déjà ce nom : ${target.slice(0, 200)}`);
        const other = existingLower.get(target.toLowerCase());
        if (other !== undefined) throw new HttpError(409, CASE_CONFLICT(other.slice(0, 200)));
        upserts.push({ path: target, sha256: f.sha256, size: f.size });
      }
      await applyWorkingChanges(id, { deletePaths: [...movingPaths], upserts });
      await audit({ action: "files.move", result: "ok", siteId: id, siteSlug: site.slug, detail: `${moving.length} fichier(s)` });
      return listFiles(id);
    });

  };
}
