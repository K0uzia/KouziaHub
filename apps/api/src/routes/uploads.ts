import type { FastifyPluginAsync } from "fastify";
import { rulesOf, siteExtras } from "@/lib/site-extras.js";
import { z } from "zod";
import type { UploadResult } from "@/contract.js";
import { requireAuth } from "@/lib/auth.js";
import { HttpError } from "@/lib/http.js";
import { importFiles, importZip } from "@/lib/imports.js";
import { MAX_FILES, UPLOAD_CHUNK_BYTES } from "@/lib/limits.js";
import { prisma } from "@/lib/prisma.js";
import type { Services } from "@/lib/services.js";
import { UploadStore, withUploadSessionBusy } from "@/lib/uploads.js";

const siteParams = z.object({ id: z.string().min(1).max(64) });
const sessionParams = siteParams.extend({ uid: z.string().min(1).max(64) });
const chunkParams = sessionParams.extend({ n: z.coerce.number().int().min(0).max(1_000_000) });

const fileDecl = z.object({ path: z.string().min(1).max(2000), size: z.number().int().min(0), sha256: z.string().length(64) });
const createSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("files"), dir: z.string().max(2000).optional(), files: z.array(fileDecl).max(MAX_FILES * 2), mode: z.enum(["replace", "merge"]).optional() }),
  z.object({
    kind: z.literal("zip"),
    mode: z.enum(["replace", "merge"]),
    name: z.string().min(1).max(255),
    size: z.number().int().min(1),
    sha256: z.string().length(64),
  }),
]);

/** Une session d'envoi décrit au plus MAX_FILES fichiers : corps JSON plus grand que le 1 Mio par défaut. */
const CREATE_BODY_LIMIT = 8 * 1024 * 1024;
const SWEEP_EVERY_MS = 60 * 60 * 1000;

async function loadSite(id: string) {
  const site = await prisma.site.findUnique({ where: { id }, select: { id: true, slug: true, state: true } });
  if (!site) throw new HttpError(404, "Site introuvable.");
  if (site.state === "DELETING") throw new HttpError(409, "Suppression en cours.");
  return site;
}

/** Envoi par morceaux : sessions reprenables, morceaux de 8 Mio vérifiés par empreinte, finalisation tout ou rien. */
export function uploadsRoutes(services: Services): FastifyPluginAsync {
  return async (app) => {
    const store = new UploadStore(services.dataDir);
    const timer = setInterval(() => void store.sweep().catch(() => undefined), SWEEP_EVERY_MS);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));

    app.addHook("onRequest", requireAuth);
    // Morceaux bruts, propres à ce plugin.
    app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: UPLOAD_CHUNK_BYTES + 1024 }, (_req, body, done) =>
      done(null, body),
    );

    app.get("/api/sites/:id/uploads", async (request) => {
      const { id } = siteParams.parse(request.params);
      await loadSite(id);
      return store.list(id);
    });

    app.post("/api/sites/:id/uploads", { bodyLimit: CREATE_BODY_LIMIT }, async (request) => {
      const { id } = siteParams.parse(request.params);
      await loadSite(id);
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) throw new HttpError(400, "Description d'envoi invalide.");
      return store.create(id, parsed.data, rulesOf(await siteExtras(id)));
    });

    app.get("/api/sites/:id/uploads/:uid", async (request) => {
      const { id, uid } = sessionParams.parse(request.params);
      await loadSite(id);
      return store.get(id, uid);
    });

    app.put("/api/sites/:id/uploads/:uid/chunks/:n", async (request) => {
      const { id, uid, n } = chunkParams.parse(request.params);
      await loadSite(id);
      if (!Buffer.isBuffer(request.body)) throw new HttpError(400, "Morceau attendu en application/octet-stream.");
      const sha = request.headers["x-chunk-sha256"];
      return store.putChunk(id, uid, n, request.body, typeof sha === "string" ? sha : undefined);
    });

    app.post("/api/sites/:id/uploads/:uid/complete", async (request): Promise<UploadResult> => {
      const { id, uid } = sessionParams.parse(request.params);
      // Session occupée (la purge du cache ne la touche pas) et blobs protégés jusqu'à l'écriture de leurs lignes.
      return withUploadSessionBusy(uid, () => services.blobs.withPins(async () => {
        const site = await loadSite(id);
        const mode = (await store.get(id, uid)).mode ?? "merge";
        const finish = async (): Promise<UploadResult> => {
          const { session, stored, zipPath, done } = await store.assemble(id, uid, services.blobs);
          try {
            // Écartés dès l'ouverture : comptés dans le résultat et dans la reconnaissance du projet (package.json...).
            const result = zipPath ? await importZip(services, site, zipPath, mode) : await importFiles(services, site, stored, session.rejected, mode);
            await done();
            // Écartés dès l'ouverture de la session (déjà dans le résultat d'un envoi de fichiers), puis ceux de la finalisation.
            return zipPath ? { ...result, rejected: [...session.rejected, ...result.rejected] } : result;
          } catch (err) {
            // Contenu refusé (zip piégé, plafond du site) : renvoyer les mêmes octets ne changerait rien.
            if (err instanceof HttpError && err.statusCode < 500) await done();
            throw err;
          }
        };
        // Remplacer : verrou du site pris AVANT d'assembler les morceaux. Une opération en cours refuse la finalisation
        // sans rien consommer : l'envoi reste entier, à finaliser plus tard (audit du 27/10/2026). Purge et écriture se font
        // ensuite en un bloc, aucune publication entre les deux.
        return mode === "replace" ? services.engine.withLock(id, finish) : finish();
      }));
    });

    app.delete("/api/sites/:id/uploads/:uid", async (request) => {
      const { id, uid } = sessionParams.parse(request.params);
      await loadSite(id);
      await store.cancel(id, uid);
      return { ok: true };
    });
  };
}
