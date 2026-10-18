import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { PushDevice } from "@/contract.js";
import { audit } from "@/lib/audit.js";
import { requireAuth } from "@/lib/auth.js";
import { HttpError } from "@/lib/http.js";
import { idParams } from "@/lib/http-input.js";
import { prisma } from "@/lib/prisma.js";
import type { Services } from "@/lib/services.js";

const subscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(2000).startsWith("https://"),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string().min(16).max(200), auth: z.string().min(8).max(100) }),
  }),
  label: z.string().trim().min(1).max(80),
});

const toDevice = (s: { id: string; label: string; endpoint: string; createdAt: Date; lastSuccessAt: Date | null; lastError: string | null }): PushDevice => ({
  id: s.id,
  label: s.label,
  endpoint: s.endpoint,
  createdAt: s.createdAt.toISOString(),
  lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
  lastError: s.lastError,
});

/** Notifications Web Push (repris de l'ERP) : clé publique, appareils, abonnement, test. */
export function pushRoutes(services: Services): FastifyPluginAsync {
  return async (app) => {
    app.addHook("onRequest", requireAuth);

    app.get("/api/push/config", async () => ({ publicKey: services.push.publicKey }));

    app.get("/api/push/devices", async (request): Promise<PushDevice[]> => {
      const subs = await prisma.pushSubscription.findMany({ where: { userId: request.user!.id }, orderBy: { createdAt: "desc" } });
      return subs.map(toDevice);
    });

    app.post("/api/push/subscribe", async (request, reply) => {
      if (!services.push.configured) throw new HttpError(503, "Notifications désactivées sur le serveur (clés VAPID absentes : hubctl push-keys).");
      const parsed = subscribeSchema.safeParse(request.body);
      if (!parsed.success) throw new HttpError(400, "Abonnement invalide.");
      const { subscription, label } = parsed.data;
      // Même appareil réabonné (clés renouvelées par le navigateur) : mise à jour, pas de doublon.
      const sub = await prisma.pushSubscription.upsert({
        where: { endpoint: subscription.endpoint },
        create: { userId: request.user!.id, endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, label },
        update: { userId: request.user!.id, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, label, lastError: null },
      });
      await audit({ action: "push.subscribe", result: "ok", detail: label });
      void services.monitor.requestSync();
      return reply.code(201).send(toDevice(sub));
    });

    app.delete("/api/push/devices/:id", async (request) => {
      const { id } = idParams.parse(request.params);
      const { count } = await prisma.pushSubscription.deleteMany({ where: { id, userId: request.user!.id } });
      if (count === 0) throw new HttpError(404, "Appareil introuvable.");
      await audit({ action: "push.unsubscribe", result: "ok" });
      void services.monitor.requestSync();
      return { ok: true as const };
    });

    app.post("/api/push/test", { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } }, async () => {
      if (!services.push.configured) throw new HttpError(503, "Notifications désactivées sur le serveur (clés VAPID absentes : hubctl push-keys).");
      const report = await services.push.sendToAll({
        title: "Hub Kouzia",
        body: "Notification de test : les alertes de surveillance arriveront sur cet appareil.",
        url: "/reglages",
        tag: `test:${Date.now()}`,
      });
      await audit({ action: "push.test", result: report.sent > 0 ? "ok" : "error", detail: `${report.sent} envoyée(s), ${report.failed} échec(s), ${report.removed} retirée(s)` });
      // Abonnement expiré (410) retiré : le Worker reçoit la liste à jour.
      if (report.removed > 0) void services.monitor.requestSync();
      return { sent: report.sent, failed: report.failed };
    });
  };
}
