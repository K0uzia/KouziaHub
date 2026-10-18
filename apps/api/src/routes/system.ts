import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AuditEntry, ErpClient, SystemStatus } from "@/contract.js";
import { requireAuth } from "@/lib/auth.js";
import { ErpUnavailableError } from "@/lib/erp/types.js";
import { HttpError } from "@/lib/http.js";
import { routeParam } from "@/lib/http-input.js";
import { prisma } from "@/lib/prisma.js";
import type { Services } from "@/lib/services.js";

const clientsQuery = z.object({ q: z.string().max(100).optional() });
const auditQuery = z.object({ siteId: routeParam.optional(), limit: z.coerce.number().int().min(1).max(500).optional() });
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

    app.get("/api/audit", async (request): Promise<AuditEntry[]> => {
      const parsed = auditQuery.safeParse(request.query);
      if (!parsed.success) throw new HttpError(400, "Paramètres invalides.");
      const rows = await prisma.auditEvent.findMany({
        where: parsed.data.siteId ? { siteId: parsed.data.siteId } : {},
        orderBy: { at: "desc" },
        take: parsed.data.limit ?? 100,
      });
      return rows.map((r) => ({
        id: r.id,
        siteSlug: r.siteSlug,
        action: r.action,
        result: r.result === "error" ? "error" : "ok",
        detail: r.detail,
        at: r.at.toISOString(),
      }));
    });
  };
}
