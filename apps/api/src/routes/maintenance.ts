import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ExportSummary } from "@/contract.js";
import { audit } from "@/lib/audit.js";
import { requireAuth } from "@/lib/auth.js";
import { assertExportBlobs, buildExportPlan, streamExport } from "@/lib/export/production.js";
import { HttpError } from "@/lib/http.js";
import { idParams, routeParam } from "@/lib/http-input.js";
import { purgeCloudflareCache, purgeHubCache, purgeSiteFiles, storageUsage } from "@/lib/maintenance.js";
import { prisma } from "@/lib/prisma.js";
import type { Services } from "@/lib/services.js";

const filesPurgeSchema = z.object({ confirm: z.string().max(64), versions: z.boolean().optional() });
const hubPurgeSchema = z
  .object({
    siteId: routeParam.nullish(),
    uploads: z.boolean().optional(),
    temp: z.boolean().optional(),
    thumbnails: z.boolean().optional(),
    orphans: z.boolean().optional(),
    confirm: z.boolean().optional(),
  })
  .strict();
const exportQuery = z.object({ version: routeParam.optional(), target: z.enum(["hostinger", "pages"]).optional() });

export function maintenanceRoutes(services: Services): FastifyPluginAsync {
  async function loadIdleSite(id: string) {
    const site = await prisma.site.findUnique({ where: { id } });
    if (!site) throw new HttpError(404, "Site introuvable.");
    if (site.state === "DELETING") throw new HttpError(409, "Suppression en cours.");
    const running = await prisma.operation.findFirst({ where: { siteId: id, status: "RUNNING" }, select: { id: true } });
    if (running || services.engine.isBusy(id)) throw new HttpError(409, "Une opération est en cours sur ce site : réessayez à la fin.", "operation_running");
    return site;
  }

  return async (app) => {
    app.addHook("onRequest", requireAuth);

    app.post("/api/sites/:id/files/purge", async (request) => {
      const { id } = idParams.parse(request.params);
      const site = await loadIdleSite(id);
      const parsed = filesPurgeSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.confirm !== site.slug) {
        throw new HttpError(400, "Confirmation incorrecte : saisir le sous-domaine exact du site.", "confirm_mismatch");
      }
      // Verrou du site pendant toute la purge : aucune publication ne démarre entre deux appels à Cloudflare.
      return services.engine.withLock(id, () => purgeSiteFiles(services, id, parsed.data.versions === true));
    });

    app.post("/api/sites/:id/cache/purge", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => {
      const { id } = idParams.parse(request.params);
      await loadIdleSite(id);
      return purgeCloudflareCache(services, id);
    });

    app.get("/api/storage", async () => storageUsage(services));

    app.post("/api/storage/purge", async (request) => {
      const parsed = hubPurgeSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw new HttpError(400, "Choix de purge invalide.");
      if ((parsed.data.uploads || parsed.data.thumbnails) && parsed.data.confirm !== true) {
        throw new HttpError(400, "Confirmation requise pour supprimer des envois en cours ou des vignettes.", "confirm_required");
      }
      if (parsed.data.siteId && !(await prisma.site.findUnique({ where: { id: parsed.data.siteId }, select: { id: true } }))) {
        throw new HttpError(404, "Site introuvable.");
      }
      const result = await purgeHubCache(services, parsed.data);
      const site = parsed.data.siteId ? await prisma.site.findUnique({ where: { id: parsed.data.siteId }, select: { slug: true } }) : null;
      await audit({
        action: "cache.purge",
        result: "ok",
        siteId: parsed.data.siteId ?? null,
        siteSlug: site?.slug ?? null,
        detail: `${Math.round(result.freedBytes / 1024)} Kio libérés (${["uploads", "temp", "thumbnails", "orphans"].filter((k) => parsed.data[k as "uploads"]).join(", ") || "rien"})`,
      });
      return result;
    });

    app.get("/api/sites/:id/export/summary", async (request): Promise<ExportSummary> => {
      const { id } = idParams.parse(request.params);
      const q = exportQuery.safeParse(request.query);
      if (!q.success) throw new HttpError(400, "Paramètres invalides (target : hostinger ou pages).");
      return (await buildExportPlan(services, id, q.data.version, q.data.target ?? "hostinger")).summary;
    });

    app.get("/api/sites/:id/export", async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const q = exportQuery.safeParse(request.query);
      if (!q.success) throw new HttpError(400, "Paramètres invalides (target : hostinger ou pages).");
      // Verrou du site pendant tout le flux : aucune purge ni publication ne retire un fichier en cours de route.
      const release = await services.engine.acquire(id);
      let plan: Awaited<ReturnType<typeof buildExportPlan>>;
      try {
        plan = await buildExportPlan(services, id, q.data.version, q.data.target ?? "hostinger");
        await assertExportBlobs(services, plan);
      } catch (err) {
        release();
        throw err;
      }
      const stream = streamExport(services, plan, (err) => {
        request.log.error({ err, siteId: id }, "export de production interrompu");
        void audit({ action: "version.export", result: "error", siteId: id, siteSlug: plan.site.slug, detail: `version ${plan.version.number} : interrompu` });
      });
      stream.once("close", release);
      await audit({
        action: "version.export",
        result: "ok",
        siteId: id,
        siteSlug: plan.site.slug,
        detail: `version ${plan.version.number}, ${plan.target}, ${plan.summary.fileCount} fichier(s)`,
      });
      return reply
        .header("Content-Type", "application/zip")
        .header("Content-Disposition", `attachment; filename="${plan.summary.fileName}"`)
        .header("Cache-Control", "private, no-store")
        .send(stream);
    });
  };
}
