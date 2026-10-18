import { createReadStream, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { CloudflareZoneSuggestion, MonitorOverview, MonitorTargetDetail, MonitorTargetEntry } from "@/contract.js";
import { audit } from "@/lib/audit.js";
import { requireAuth } from "@/lib/auth.js";
import { ERP_CLIENT_ID, ErpUnavailableError } from "@/lib/erp/types.js";
import { HttpError } from "@/lib/http.js";
import { idParams, routeParam } from "@/lib/http-input.js";
import { generateReport, MONTH_RE } from "@/lib/monitor/report.js";
import type { TargetWithSite } from "@/lib/monitor/service.js";
import { buildEntries, incidentEntry } from "@/lib/monitor/view.js";
import { prisma } from "@/lib/prisma.js";
import { normalizeFinalDomain } from "@/lib/server-config.js";
import type { Services } from "@/lib/services.js";
import { erpNames } from "@/lib/site-view.js";

const label = z.string().trim().min(1, "Libellé vide.").max(120, "120 caractères au plus.");
const keyword = z.string().trim().max(200).nullable();
const createSchema = z.object({ url: z.string().trim().max(500), label, erpClientId: z.string().regex(ERP_CLIENT_ID).nullish(), keyword: keyword.optional() });
const updateSchema = z
  .object({ label: label.optional(), enabled: z.boolean().optional(), keyword: keyword.optional(), erpClientId: z.string().regex(ERP_CLIENT_ID).nullable().optional() })
  .strict();
const detailQuery = z.object({ days: z.coerce.number().int().min(1).max(400).optional() });
const reportParams = z.object({ id: routeParam, file: routeParam });
const zoneParams = z.object({ name: routeParam });

const include = { site: { select: { id: true, slug: true, state: true } } } as const;

function badRequest(error: z.ZodError): HttpError {
  const first = error.issues[0];
  return new HttpError(400, first?.message && !first.message.startsWith("Invalid") ? first.message : "Données invalides.");
}

/** URL surveillée : http(s), nom d'hôte valide, sans identifiants. */
function parseTargetUrl(raw: string): { url: string; hostname: string } {
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new HttpError(400, "Adresse invalide.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new HttpError(400, "Adresse en https:// ou http:// seulement.");
  if (u.username || u.password) throw new HttpError(400, "Adresse sans identifiants.");
  const host = normalizeFinalDomain(u.hostname.startsWith("www.") ? u.hostname.slice(4) : u.hostname);
  if (!host.ok) throw new HttpError(400, "Nom de domaine invalide.");
  u.hash = "";
  return { url: u.toString(), hostname: u.hostname.toLowerCase() };
}

export function monitorRoutes(services: Services): FastifyPluginAsync {
  const monitor = services.monitor;

  async function ensureClient(id: string): Promise<void> {
    try {
      if (!(await services.erp.get(id))) throw new HttpError(400, "Client introuvable dans l'ERP.");
    } catch (err) {
      if (err instanceof ErpUnavailableError) throw new HttpError(503, "Clients de l'ERP indisponibles : réessayez plus tard.", "erp_unavailable");
      throw err;
    }
  }

  async function entries(targets: TargetWithSite[]): Promise<MonitorTargetEntry[]> {
    const erp = targets.some((t) => t.erpClientId) ? await erpNames(services) : { names: new Map<string, string>() };
    return buildEntries(monitor, targets, erp.names);
  }

  async function entryOf(id: string): Promise<MonitorTargetEntry> {
    const target = await prisma.monitorTarget.findUnique({ where: { id }, include });
    if (!target) throw new HttpError(404, "Cible introuvable.");
    return (await entries([target]))[0]!;
  }

  async function loadTarget(id: string) {
    const target = await prisma.monitorTarget.findUnique({ where: { id }, include });
    if (!target) throw new HttpError(404, "Cible introuvable.");
    return target;
  }

  return async (app) => {
    app.addHook("onRequest", requireAuth);

    app.get("/api/monitor", async (): Promise<MonitorOverview> => {
      const targets = await prisma.monitorTarget.findMany({ include, orderBy: { createdAt: "asc" } });
      const active = new Set((await monitor.activeTargets()).map((t) => t.id));
      const list = await entries(targets);
      const watched = list.filter((e) => active.has(e.id));
      const warning = (e: MonitorTargetEntry) =>
        e.verdict === "local_only" ||
        e.verdict === "edge_only" ||
        (e.certificate !== null && (!e.certificate.ok || e.certificate.daysLeft <= 30)) ||
        (e.domainExpiry?.daysLeft != null && e.domainExpiry.daysLeft <= 30) ||
        e.dns?.status === "drift" ||
        e.content?.status === "changed";
      const recent = await prisma.monitorIncident.findMany({ orderBy: { startedAt: "desc" }, take: 20, include: { target: { select: { label: true } } } });
      return {
        targets: list,
        stats: {
          watched: watched.length,
          up: watched.filter((e) => e.verdict === "up").length,
          down: watched.filter((e) => e.verdict === "down").length,
          warnings: watched.filter(warning).length,
          openIncidents: await prisma.monitorIncident.count({ where: { endedAt: null } }),
        },
        health: {
          edge: {
            configured: monitor.veille.configured,
            lastSeenAt: monitor.health.edgeSeenAt ? new Date(monitor.health.edgeSeenAt).toISOString() : null,
            lastSyncAt: monitor.health.lastSyncAt ? new Date(monitor.health.lastSyncAt).toISOString() : null,
            error: monitor.health.error,
          },
          hubChecksRunning: monitor.started,
          push: { configured: services.push.configured, devices: await prisma.pushSubscription.count() },
          zonesToken: services.zones.configured,
        },
        recentIncidents: recent.map((i) => incidentEntry(i, i.target.label)),
      };
    });

    app.post("/api/monitor/targets", async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest(parsed.error);
      const { url, hostname } = parseTargetUrl(parsed.data.url);
      if (await prisma.monitorTarget.findFirst({ where: { url }, select: { id: true } })) throw new HttpError(409, "Cette adresse est déjà surveillée.");
      if (parsed.data.erpClientId) await ensureClient(parsed.data.erpClientId);
      const target = await prisma.monitorTarget.create({
        data: { url, hostname, label: parsed.data.label, source: "manual", erpClientId: parsed.data.erpClientId ?? null, keyword: parsed.data.keyword || null },
      });
      await audit({ action: "monitor.target.create", result: "ok", detail: hostname });
      void monitor.requestSync();
      return reply.code(201).send(await entryOf(target.id));
    });

    app.get("/api/monitor/targets/:id", async (request): Promise<MonitorTargetDetail> => {
      const { id } = idParams.parse(request.params);
      const { days = 30 } = detailQuery.parse(request.query);
      const entry = await entryOf(id);
      const since = new Date(monitor.now() - days * 86_400_000);
      const [hourly, incidents, reports] = await Promise.all([
        prisma.monitorHourly.findMany({ where: { targetId: id, hour: { gte: since } }, orderBy: { hour: "asc" } }),
        prisma.monitorIncident.findMany({ where: { targetId: id, OR: [{ endedAt: null }, { endedAt: { gte: since } }] }, orderBy: { startedAt: "desc" }, take: 100 }),
        prisma.monitorReport.findMany({ where: { targetId: id }, orderBy: { month: "desc" } }),
      ]);
      return {
        ...entry,
        history: hourly.map((h) => ({
          hour: h.hour.toISOString(),
          observer: h.observer === "edge" ? "edge" : "hub",
          checks: h.checks,
          failures: h.failures,
          avgMs: h.avgMs,
          p95Ms: h.p95Ms,
        })),
        incidents: incidents.map((i) => incidentEntry(i, entry.label)),
        reports: reports.map((r) => ({ id: r.id, month: r.month, createdAt: r.createdAt.toISOString() })),
      };
    });

    app.patch("/api/monitor/targets/:id", async (request) => {
      const { id } = idParams.parse(request.params);
      const parsed = updateSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw badRequest(parsed.error);
      const target = await loadTarget(id);
      if (target.source === "site" && parsed.data.erpClientId !== undefined) {
        throw new HttpError(400, "Le client d'une cible de site se règle dans la fiche du site.");
      }
      if (parsed.data.erpClientId) await ensureClient(parsed.data.erpClientId);
      await prisma.monitorTarget.update({
        where: { id },
        data: {
          ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
          ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
          ...(parsed.data.keyword !== undefined ? { keyword: parsed.data.keyword || null } : {}),
          ...(parsed.data.erpClientId !== undefined ? { erpClientId: parsed.data.erpClientId } : {}),
        },
      });
      await audit({
        action: "monitor.target.update",
        result: "ok",
        siteId: target.siteId,
        siteSlug: target.site?.slug ?? null,
        detail: parsed.data.enabled === undefined ? target.hostname : `${target.hostname} : ${parsed.data.enabled ? "surveillée" : "non surveillée"}`,
      });
      void monitor.requestSync();
      return entryOf(id);
    });

    app.delete("/api/monitor/targets/:id", async (request) => {
      const { id } = idParams.parse(request.params);
      const target = await loadTarget(id);
      if (target.source === "site") throw new HttpError(409, "Une cible de site suit le site : couper l'interrupteur « Surveillé » à la place.");
      await prisma.monitorTarget.delete({ where: { id } });
      await rm(path.join(services.dataDir, "reports", id), { recursive: true, force: true });
      await audit({ action: "monitor.target.delete", result: "ok", detail: target.hostname });
      void monitor.requestSync();
      return { ok: true as const };
    });

    app.post("/api/monitor/targets/:id/check", async (request) => {
      const { id } = idParams.parse(request.params);
      const target = await loadTarget(id);
      await monitor.checkHttp(target);
      await monitor.evaluate([target]);
      return entryOf(id);
    });

    app.post("/api/monitor/targets/:id/dns/accept", async (request) => {
      const { id } = idParams.parse(request.params);
      const target = await loadTarget(id);
      try {
        await monitor.acceptDns(target);
      } catch {
        throw new HttpError(502, "Résolution DNS impossible : réessayez plus tard.");
      }
      return entryOf(id);
    });

    app.post("/api/monitor/targets/:id/content/accept", async (request) => {
      const { id } = idParams.parse(request.params);
      const target = await loadTarget(id);
      if (!(await monitor.acceptContent(target))) throw new HttpError(502, "Accueil injoignable : référence inchangée.");
      return entryOf(id);
    });

    app.get("/api/monitor/targets/:id/reports/:file", async (request, reply) => {
      const { id, file } = reportParams.parse(request.params);
      const m = /^(\d{4}-\d{2})\.pdf$/.exec(file);
      if (!m || !MONTH_RE.test(m[1]!)) throw new HttpError(404, "Rapport introuvable.");
      const month = m[1]!;
      const now = new Date(monitor.now());
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      if (month > currentMonth) throw new HttpError(400, "Mois à venir : pas de rapport.");
      const target = await loadTarget(id);
      const existing = await prisma.monitorReport.findUnique({ where: { targetId_month: { targetId: id, month } } });
      let filePath = existing ? path.join(services.dataDir, existing.path) : null;
      // Mois en cours : toujours régénéré (chiffres à jour) ; mois passé : généré s'il manque.
      if (!filePath || !existsSync(filePath) || month === currentMonth) {
        const generated = await generateReport(services.dataDir, target, month, monitor.now());
        filePath = path.join(services.dataDir, generated.path);
        await audit({ action: "monitor.report.generate", result: "ok", siteId: target.siteId, siteSlug: target.site?.slug ?? null, detail: `${target.hostname} ${month}` });
      }
      const safeHost = target.hostname.replace(/[^a-z0-9.-]/gi, "_");
      return reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `attachment; filename="surveillance-${safeHost}-${month}.pdf"`)
        .header("Cache-Control", "private, no-store")
        .send(createReadStream(filePath));
    });

    app.get("/api/monitor/zones", async (): Promise<{ available: boolean; zones: CloudflareZoneSuggestion[] }> => {
      if (!services.zones.configured) return { available: false, zones: [] };
      let zones: string[];
      try {
        zones = await services.zones.listZones();
      } catch {
        return { available: false, zones: [] };
      }
      const hosts = new Set((await prisma.monitorTarget.findMany({ select: { hostname: true } })).map((t) => t.hostname));
      return { available: true, zones: zones.map((name) => ({ name, alreadyWatched: hosts.has(name) || hosts.has(`www.${name}`) })) };
    });

    app.post("/api/monitor/zones/:name/watch", async (request, reply) => {
      const { name } = zoneParams.parse(request.params);
      if (!services.zones.configured) throw new HttpError(409, "Jeton de lecture des zones absent (hubctl secrets veille).");
      let zones: string[];
      try {
        zones = await services.zones.listZones();
      } catch {
        throw new HttpError(502, "Lecture des zones Cloudflare impossible.");
      }
      const zone = name.toLowerCase();
      if (!zones.includes(zone)) throw new HttpError(404, "Zone introuvable dans le compte Cloudflare.");
      if (await prisma.monitorTarget.findFirst({ where: { hostname: { in: [zone, `www.${zone}`] } }, select: { id: true } })) {
        throw new HttpError(409, "Ce domaine est déjà surveillé.");
      }
      const target = await prisma.monitorTarget.create({ data: { url: `https://${zone}/`, hostname: zone, label: zone, source: "cloudflare" } });
      await audit({ action: "monitor.zone.watch", result: "ok", detail: zone });
      void monitor.requestSync();
      return reply.code(201).send(await entryOf(target.id));
    });

    app.get("/api/sites/:id/monitor", async (request) => {
      const { id } = idParams.parse(request.params);
      if (!(await prisma.site.findUnique({ where: { id }, select: { id: true } }))) throw new HttpError(404, "Site introuvable.");
      return entries(await prisma.monitorTarget.findMany({ where: { siteId: id }, include, orderBy: { createdAt: "asc" } }));
    });
  };
}
