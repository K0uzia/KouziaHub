import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ServerConfigPreview, VersionEntry } from "@/contract.js";
import { buildHtaccess, normalizeFinalDomain, notFoundPageError, pagesDeployConfig } from "@/lib/server-config.js";
import { profileOf, writeServerConfig } from "@/lib/server-config-store.js";
import { syncSiteTargets } from "@/lib/monitor/targets.js";
import { audit } from "@/lib/audit.js";
import { requireAuth } from "@/lib/auth.js";
import { ERP_CLIENT_ID, ErpUnavailableError } from "@/lib/erp/types.js";
import { applyWorkingChanges, listFiles } from "@/lib/files.js";
import { HttpError } from "@/lib/http.js";
import { idParams, routeParam } from "@/lib/http-input.js";
import { MAX_THUMBNAIL_UPLOAD_BYTES } from "@/lib/limits.js";
import { prisma } from "@/lib/prisma.js";
import { snapshotVersion, snapshotWorking } from "@/lib/publish.js";
import type { Services } from "@/lib/services.js";
import { catalog, siteDetail, toOperation } from "@/lib/site-view.js";
import { checkSlug, hubZoneConflict, projectNameFor, suggestSlug } from "@/lib/slug.js";
import { toThumbnail } from "@/lib/thumbnails.js";

const label = z.string().trim().min(1, "Libellé vide.").max(120, "120 caractères au plus.");
const slugField = z.string().trim().toLowerCase().max(64);

const createSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CLIENT"), erpClientId: z.string().regex(ERP_CLIENT_ID), slug: slugField, label: label.nullish() }),
  z.object({ kind: z.literal("PERSO"), slug: slugField, label }),
]);

const updateSchema = z
  .object({
    label: label.nullable().optional(),
    erpClientId: z.string().regex(ERP_CLIENT_ID).nullable().optional(),
    finalDomain: z.string().max(260).nullable().optional(),
    canonicalHost: z.enum(["www", "apex"]).optional(),
    notFoundPage: z.string().max(220).optional(),
  })
  .strict();
const regenerateSchema = z.object({ force: z.boolean().optional() }).nullish();

const slugQuery = z.object({ slug: z.string().max(64).optional(), name: z.string().max(200).optional() });
const opParams = z.object({ id: routeParam, opId: routeParam });
const versionParams = z.object({ id: routeParam, vid: routeParam });
const deleteSchema = z.object({ confirm: z.string().max(64) });
const publishSchema = z.object({ note: z.string().trim().max(500).optional() }).nullish();

async function loadSite(id: string) {
  const site = await prisma.site.findUnique({ where: { id } });
  if (!site) throw new HttpError(404, "Site introuvable.");
  return site;
}

function badRequest(error: z.ZodError): HttpError {
  const first = error.issues[0];
  return new HttpError(400, first?.message && !first.message.startsWith("Invalid") ? first.message : "Données invalides.");
}

async function ensureErpClient(services: Services, erpClientId: string): Promise<void> {
  try {
    if (!(await services.erp.get(erpClientId))) throw new HttpError(400, "Client introuvable dans l'ERP.");
  } catch (err) {
    if (err instanceof ErpUnavailableError) throw new HttpError(503, "Clients de l'ERP indisponibles : réessayez plus tard.", "erp_unavailable");
    throw err;
  }
}

async function ensureIdle(services: Services, siteId: string): Promise<void> {
  const running = await prisma.operation.findFirst({ where: { siteId, status: "RUNNING" }, select: { id: true } });
  if (running || services.engine.isBusy(siteId)) throw new HttpError(409, "Une opération est déjà en cours sur ce site.", "operation_running");
}

export function sitesRoutes(services: Services): FastifyPluginAsync {
  return async (app) => {
    app.addHook("onRequest", requireAuth);

    app.get("/api/sites", async () => catalog(services));

    app.get("/api/sites/slug-check", async (request) => {
      const q = slugQuery.parse(request.query);
      const slug = q.slug !== undefined ? q.slug.trim().toLowerCase() : suggestSlug(q.name ?? "");
      return checkSlug(slug, services.cloudflare, services.sitesDomain);
    });

    app.post("/api/sites", async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest(parsed.error);
      const input = parsed.data;
      const check = await checkSlug(input.slug, services.cloudflare, services.sitesDomain);
      if (!check.ok) throw new HttpError(409, check.reason ?? "Sous-domaine indisponible.", "slug_unavailable");
      if (input.kind === "CLIENT") await ensureErpClient(services, input.erpClientId);
      const site = await prisma.site.create({
        data: {
          slug: input.slug,
          kind: input.kind,
          erpClientId: input.kind === "CLIENT" ? input.erpClientId : null,
          label: input.label ?? null,
          pagesProject: projectNameFor(input.slug),
          state: "CREATING",
        },
      });
      await writeServerConfig(services.blobs, site.id, { reason: "création du site" });
      await syncSiteTargets(site.id, services.sitesDomain);
      await services.engine.start(site.id, "CREATE");
      return reply.code(201).send(await siteDetail(site.id, services));
    });

    app.get("/api/sites/:id", async (request) => {
      const { id } = idParams.parse(request.params);
      return siteDetail(id, services);
    });

    app.patch("/api/sites/:id", async (request) => {
      const { id } = idParams.parse(request.params);
      const parsed = updateSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw badRequest(parsed.error);
      const site = await loadSite(id);
      const nextLabel = parsed.data.label !== undefined ? parsed.data.label : site.label;
      const nextClient = parsed.data.erpClientId !== undefined ? parsed.data.erpClientId : site.erpClientId;
      if (!nextClient && !nextLabel) throw new HttpError(400, "Un site perso doit avoir un libellé.");
      if (nextClient && nextClient !== site.erpClientId) await ensureErpClient(services, nextClient);
      let finalDomain = site.finalDomain;
      if (parsed.data.finalDomain !== undefined) {
        if (parsed.data.finalDomain === null || parsed.data.finalDomain.trim() === "") finalDomain = null;
        else {
          const normalized = normalizeFinalDomain(parsed.data.finalDomain);
          if (!normalized.ok) throw new HttpError(400, normalized.reason);
          for (const host of [normalized.value, `www.${normalized.value}`]) {
            const conflict = await hubZoneConflict(host, services.sitesDomain, id);
            if (conflict) throw new HttpError(400, `Domaine final refusé : ${conflict}`, "final_domain_conflict");
          }
          finalDomain = normalized.value;
        }
      }
      const notFoundPage = parsed.data.notFoundPage ?? site.notFoundPage;
      const notFoundError = notFoundPageError(notFoundPage);
      if (notFoundError) throw new HttpError(400, notFoundError);
      const canonicalHost = parsed.data.canonicalHost ?? site.canonicalHost;
      const profileChanged = finalDomain !== site.finalDomain || canonicalHost !== site.canonicalHost || notFoundPage !== site.notFoundPage;
      await prisma.site.update({
        where: { id },
        data: { label: nextLabel, erpClientId: nextClient, kind: nextClient ? "CLIENT" : "PERSO", finalDomain, canonicalHost, notFoundPage, touchedAt: new Date() },
      });
      await audit({ action: "site.update", result: "ok", siteId: id, siteSlug: site.slug });
      if (profileChanged) await writeServerConfig(services.blobs, id, { reason: "profil modifié" });
      if (profileChanged || nextClient !== site.erpClientId) {
        if (await syncSiteTargets(id, services.sitesDomain)) void services.monitor.requestSync();
      }
      return siteDetail(id, services);
    });

    app.post("/api/sites/:id/enable", async (request) => {
      const { id } = idParams.parse(request.params);
      const site = await loadSite(id);
      if (site.state === "ONLINE") throw new HttpError(409, "Le site est déjà en ligne.");
      if (site.state !== "OFFLINE") throw new HttpError(409, "Site en création ou en suppression : reprendre l'opération en cours.");
      await services.engine.start(id, "ENABLE");
      return siteDetail(id, services);
    });

    app.post("/api/sites/:id/disable", async (request) => {
      const { id } = idParams.parse(request.params);
      const site = await loadSite(id);
      // Hors ligne mais CNAME ou domaine encore posés (remise en ligne interrompue) : la coupure reste possible.
      const attached = site.dnsRecordId !== null || site.domainStatus !== "NONE";
      if (site.state === "OFFLINE" && !attached) throw new HttpError(409, "Le site est déjà hors ligne.");
      if (site.state === "DELETING") throw new HttpError(409, "Suppression en cours : reprendre la suppression.");
      await services.engine.start(id, "DISABLE");
      return siteDetail(id, services);
    });

    app.post("/api/sites/:id/operations/:opId/retry", async (request) => {
      const { id, opId } = opParams.parse(request.params);
      await loadSite(id);
      await services.engine.retry(id, opId);
      return siteDetail(id, services);
    });

    app.delete("/api/sites/:id", async (request) => {
      const { id } = idParams.parse(request.params);
      const site = await loadSite(id);
      const parsed = deleteSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.confirm !== site.slug) {
        throw new HttpError(400, "Confirmation incorrecte : saisir le sous-domaine exact du site.", "confirm_mismatch");
      }
      const detailBefore = await siteDetail(id, services);
      const op = await services.engine.start(id, "DELETE");
      await prisma.site.update({ where: { id }, data: { state: "DELETING" } }).catch(() => undefined);
      return {
        ...detailBefore,
        state: "DELETING" as const,
        operation: toOperation(op),
      };
    });

    // --- Publication et versions ---

    app.post("/api/sites/:id/publish", async (request) => {
      const { id } = idParams.parse(request.params);
      const parsed = publishSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest(parsed.error);
      const site = await loadSite(id);
      if (site.state === "DELETING") throw new HttpError(409, "Suppression en cours.");
      if (!site.pagesSubdomain) throw new HttpError(409, "Le projet Cloudflare n'est pas encore créé : reprendre la création.");
      await ensureIdle(services, id);
      const version = await snapshotWorking(id, parsed.data?.note || null);
      try {
        await services.engine.start(id, "PUBLISH", { versionId: version.id, versionNumber: version.number });
      } catch (err) {
        await prisma.version.delete({ where: { id: version.id } }).catch(() => undefined);
        throw err;
      }
      return siteDetail(id, services);
    });

    app.get("/api/sites/:id/versions", async (request): Promise<VersionEntry[]> => {
      const { id } = idParams.parse(request.params);
      const site = await loadSite(id);
      const versions = await prisma.version.findMany({ where: { siteId: id }, orderBy: { number: "desc" } });
      const numbers = new Map(versions.map((v) => [v.id, v.number]));
      return versions.map((v) => ({
        id: v.id,
        number: v.number,
        note: v.note,
        source: (["files", "zip", "placeholder", "republish"].includes(v.source) ? v.source : "files") as VersionEntry["source"],
        sourceVersionNumber: v.sourceVersionId ? (numbers.get(v.sourceVersionId) ?? null) : null,
        fileCount: v.fileCount,
        totalBytes: v.totalBytes,
        status: v.status,
        error: v.error,
        createdAt: v.createdAt.toISOString(),
        publishedAt: v.publishedAt?.toISOString() ?? null,
        current: v.id === site.currentVersionId,
      }));
    });

    app.post("/api/sites/:id/versions/:vid/publish", async (request) => {
      const { id, vid } = versionParams.parse(request.params);
      const site = await loadSite(id);
      if (site.state === "DELETING") throw new HttpError(409, "Suppression en cours.");
      if (!site.pagesSubdomain) throw new HttpError(409, "Le projet Cloudflare n'est pas encore créé : reprendre la création.");
      await ensureIdle(services, id);
      const version = await snapshotVersion(id, vid);
      try {
        await services.engine.start(id, "PUBLISH", { versionId: version.id, versionNumber: version.number, republishOf: vid });
      } catch (err) {
        await prisma.version.delete({ where: { id: version.id } }).catch(() => undefined);
        throw err;
      }
      return siteDetail(id, services);
    });

    app.post("/api/sites/:id/versions/:vid/restore", async (request) => {
      const { id, vid } = versionParams.parse(request.params);
      const site = await loadSite(id);
      const version = await prisma.version.findFirst({ where: { id: vid, siteId: id }, include: { files: true } });
      if (!version) throw new HttpError(404, "Version introuvable.");
      if (version.status === "PURGED") throw new HttpError(409, "Version purgée : ses fichiers ne sont plus gardés.");
      if (version.source === "placeholder") throw new HttpError(409, "La page d'attente ne se restaure pas.");
      await applyWorkingChanges(id, { replaceAll: true, upserts: version.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })) });
      await audit({ action: "files.restore", result: "ok", siteId: id, siteSlug: site.slug, detail: `version ${version.number}` });
      void services.blobs.gc().catch(() => undefined);
      return listFiles(id);
    });

    // --- Configuration serveur (.htaccess de l'hébergement final, _headers et _redirects de Pages) ---

    app.get("/api/sites/:id/server-config/preview", async (request): Promise<ServerConfigPreview> => {
      const { id } = idParams.parse(request.params);
      const site = await loadSite(id);
      const userFiles = await prisma.workingFile.findMany({ where: { siteId: id, path: { in: ["_headers", "_redirects"] } } });
      const read = async (p: string) => {
        const f = userFiles.find((x) => x.path === p);
        return f ? (await services.blobs.read(f.sha256)).toString("utf8") : undefined;
      };
      const user = { headers: await read("_headers"), redirects: await read("_redirects") };
      const config = pagesDeployConfig(profileOf(site), new Set(), user);
      return {
        htaccess: buildHtaccess(profileOf(site)),
        pagesHeaders: config.headersFile ?? null,
        pagesRedirects: config.redirectsFile ?? null,
        hubCacheRules: config.cacheRules,
      };
    });

    app.post("/api/sites/:id/server-config/regenerate", async (request) => {
      const { id } = idParams.parse(request.params);
      const parsed = regenerateSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest(parsed.error);
      const site = await loadSite(id);
      if (site.state === "DELETING") throw new HttpError(409, "Suppression en cours.");
      const result = await writeServerConfig(services.blobs, id, { force: parsed.data?.force === true, reason: "régénération demandée" });
      if (!result.written) {
        throw new HttpError(
          409,
          result.state.status === "modified"
            ? "Le .htaccess a été modifié à la main : confirmer pour le remplacer par la version générée."
            : "Le .htaccess a été supprimé : confirmer pour le recréer.",
          "server_config_modified",
        );
      }
      return siteDetail(id, services);
    });

    // --- Vignettes ---

    app.get("/api/sites/:id/thumbnail", async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const site = await loadSite(id);
      if (!site.thumbnailPath) throw new HttpError(404, "Pas de vignette.");
      const file = path.join(services.dataDir, site.thumbnailPath);
      const info = await stat(file).catch(() => null);
      if (!info) throw new HttpError(404, "Pas de vignette.");
      return reply
        .header("Content-Type", "image/webp")
        .header("Content-Length", String(info.size))
        .header("Cache-Control", "private, max-age=86400")
        .send(createReadStream(file));
    });

    app.post("/api/sites/:id/thumbnail", async (request) => {
      const { id } = idParams.parse(request.params);
      const site = await loadSite(id);
      if (!request.isMultipart()) throw new HttpError(400, "Envoi multipart attendu.");
      const part = await request.file({ limits: { fileSize: MAX_THUMBNAIL_UPLOAD_BYTES, files: 1 }, throwFileSizeLimit: false });
      if (!part) throw new HttpError(400, "Image attendue.");
      if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(part.mimetype)) {
        part.file.resume();
        throw new HttpError(400, "Formats acceptés : PNG, JPEG, WebP, GIF ou AVIF.");
      }
      const buffer = await part.toBuffer();
      if (part.file.truncated) throw new HttpError(413, `Image trop lourde : ${MAX_THUMBNAIL_UPLOAD_BYTES / 1024 / 1024} Mio au plus.`);
      let image: Buffer;
      try {
        image = await toThumbnail(buffer);
      } catch {
        throw new HttpError(400, "Image illisible.");
      }
      await services.thumbnails.save(id, image, "upload");
      await audit({ action: "thumbnail.upload", result: "ok", siteId: id, siteSlug: site.slug });
      return siteDetail(id, services);
    });

    app.post("/api/sites/:id/thumbnail/capture", async (request) => {
      const { id } = idParams.parse(request.params);
      const site = await loadSite(id);
      const capture = await services.thumbnails.captureStatus();
      if (!capture.available) {
        throw new HttpError(409, `${capture.reason ?? "Capture indisponible"} Envoyer une image.`, "capture_unavailable");
      }
      if (!site.currentVersionId) throw new HttpError(409, "Rien n'est encore publié.");
      services.thumbnails.enqueue(id);
      return siteDetail(id, services);
    });
  };
}
