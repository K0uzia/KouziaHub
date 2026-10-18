import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AuditEntry, ErpClient, Page, SystemStatus } from "@/contract.js";
import { requireAuth } from "@/lib/auth.js";
import { ErpUnavailableError } from "@/lib/erp/types.js";
import { HttpError } from "@/lib/http.js";
import { routeParam } from "@/lib/http-input.js";
import { badListQuery, dayParam, dayRange, pageOf, pageQuery, skipTake } from "@/lib/pagination.js";
import { prisma } from "@/lib/prisma.js";
import type { Services } from "@/lib/services.js";

const clientsQuery = z.object({ q: z.string().max(100).optional() });
const auditQuery = pageQuery.extend({
  siteId: routeParam.optional(),
  action: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/).optional(),
  result: z.enum(["ok", "error"]).optional(),
  from: dayParam.optional(),
  to: dayParam.optional(),
});
const orphanDeleteSchema = z.object({ name: z.string().trim().min(1).max(253) });

export function systemRoutes(services: Services): FastifyPluginAsync {
  return async (app) => {
    app.addHook("onRequest", requireAuth);

    app.get("/api/erp/clients", async (request): Promise<{ clients: ErpClient[]; available: boolean }> => {
      const { q } = clientsQuery.parse(request.query);
      try {
        return { clients: await services.erp.list(q), available: true };
      } catch (err) {
        if (err instanceof ErpUnavailableError) return { clients: [], available: false };
        throw err;
      }
    });

    app.get("/api/system", async (): Promise<SystemStatus> => {
      const [projectsUsed, reachable, capture, speed] = await Promise.all([
        services.projects.used(),
        services.erp.list().then(
          () => true,
          () => false,
        ),
        services.thumbnails.captureStatus(),
        services.monitor.speedStatus(),
      ]);
      return {
        cloudflare: { mode: services.cloudflare.mode, projectsUsed, projectsLimit: services.projects.limit },
        erp: { mode: services.erp.mode, reachable },
        thumbnails: { capture: capture.available, reason: capture.reason },
        speed,
        sitesDomain: services.sitesDomain,
      };
    });

    app.get("/api/orphans", async () => services.orphans.latest());

    app.post("/api/orphans/check", async () => services.orphans.check());

    app.post("/api/orphans/dns/delete", async (request) => {
      const parsed = orphanDeleteSchema.safeParse(request.body);
      if (!parsed.success) throw new HttpError(400, "Nom d'enregistrement attendu.");
      return services.orphans.deleteDns(parsed.data.name);
    });

    app.get("/api/audit", async (request): Promise<Page<AuditEntry>> => {
      const parsed = auditQuery.safeParse(request.query);
      if (!parsed.success) throw badListQuery();
      const q = parsed.data;
      const at = dayRange(q.from, q.to);
      // Résultat : tout ce qui n'est pas « error » compte comme réussi (même règle que l'affichage).
      const where = {
        ...(q.siteId ? { siteId: q.siteId } : {}),
        ...(q.action ? { action: q.action } : {}),
        ...(q.result === "error" ? { result: "error" } : q.result === "ok" ? { result: { not: "error" } } : {}),
        ...(at ? { at } : {}),
      };
      const [total, rows] = await Promise.all([
        prisma.auditEvent.count({ where }),
        prisma.auditEvent.findMany({ where, orderBy: [{ at: "desc" }, { id: "desc" }], ...skipTake(q) }),
      ]);
      const items: AuditEntry[] = rows.map((r) => ({
        id: r.id,
        siteSlug: r.siteSlug,
        action: r.action,
        result: r.result === "error" ? "error" : "ok",
        detail: r.detail,
        at: r.at.toISOString(),
      }));
      return pageOf(items, total, q);
    });
  };
}
