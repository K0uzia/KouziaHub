import { buildPushPayload } from "@block65/webcrypto-web-push";
import type { PushSubscription } from "@prisma/client";
import type { PushSubscriptionSpec } from "@/lib/monitor/core.js";
import { prisma } from "@/lib/prisma.js";
import { vapidStatus, type VapidConfig } from "@/lib/push/vapid.js";

/** Contenu d'une notification (titre, texte court, écran à ouvrir). */
export type PushPayload = { title: string; body: string; url: string; tag?: string; urgent?: boolean };

export type SendReport = { sent: number; failed: number; removed: number };

/** Sujet de remplacement (32 caractères base64url au plus) : une même alerte ne s'empile pas. */
const topicOf = (tag: string) => Buffer.from(tag).toString("base64url").slice(0, 32);

/** Notifications Web Push (repris de l'ERP) ; fetch injectable pour les tests. */
export class PushService {
  private readonly fetchImpl: typeof fetch;
  private readonly config: () => VapidConfig | null;

  constructor(options: { fetch?: typeof fetch; vapid?: VapidConfig | null } = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.config = options.vapid !== undefined ? () => options.vapid ?? null : () => vapidStatus().config;
  }

  get configured(): boolean {
    return this.config() !== null;
  }

  get publicKey(): string | null {
    return this.config()?.publicKey ?? null;
  }

  /** 404 ou 410 : l'abonnement n'existe plus côté navigateur, il est supprimé. */
  private async sendOne(sub: PushSubscription, payload: PushPayload, config: VapidConfig): Promise<"ok" | "gone" | "error"> {
    try {
      const req = await buildPushPayload(
        {
          data: { title: payload.title, body: payload.body, url: payload.url, ...(payload.tag ? { tag: payload.tag } : {}) },
          options: { ttl: 24 * 3600, urgency: payload.urgent ? "high" : "normal", ...(payload.tag ? { topic: topicOf(payload.tag) } : {}) },
        },
        { endpoint: sub.endpoint, expirationTime: null, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        config,
      );
      const res = await this.fetchImpl(sub.endpoint, req);
      if (res.ok) {
        await prisma.pushSubscription.update({ where: { id: sub.id }, data: { lastSuccessAt: new Date(), lastError: null } });
        return "ok";
      }
      if (res.status === 404 || res.status === 410) {
        await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => undefined);
        return "gone";
      }
      await prisma.pushSubscription.update({ where: { id: sub.id }, data: { lastErrorAt: new Date(), lastError: `HTTP ${res.status}` } });
      return "error";
    } catch (err) {
      await prisma.pushSubscription
        .update({ where: { id: sub.id }, data: { lastErrorAt: new Date(), lastError: err instanceof Error ? err.message.slice(0, 200) : "erreur" } })
        .catch(() => undefined);
      return "error";
    }
  }

  /** Hub mono-utilisateur : les alertes vont à tous les appareils abonnés. */
  async sendToAll(payload: PushPayload): Promise<SendReport> {
    const report: SendReport = { sent: 0, failed: 0, removed: 0 };
    const config = this.config();
    if (!config) return report;
    for (const sub of await prisma.pushSubscription.findMany()) {
      const r = await this.sendOne(sub, payload, config);
      if (r === "ok") report.sent++;
      else if (r === "gone") report.removed++;
      else report.failed++;
    }
    return report;
  }

  /** Abonnements recopiés vers le Worker (/sync) pour qu'il puisse alerter seul. */
  async specs(): Promise<PushSubscriptionSpec[]> {
    const subs = await prisma.pushSubscription.findMany({ select: { endpoint: true, p256dh: true, auth: true } });
    return subs.map((s) => ({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }));
  }
}
