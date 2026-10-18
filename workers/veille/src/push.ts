// Notifications urgentes envoyées par le Worker (cadrage 10.1 et 10.6) : textes, file d'envoi D1, envoi
// Web Push (RFC 8291 et 8292) par la même bibliothèque que l'ERP, faite pour WebCrypto.
import { buildPushPayload } from "@block65/webcrypto-web-push";
import { GROUP_ALERT_THRESHOLD, type Observer } from "../../../apps/api/src/lib/monitor/core.js";
import { PUSH_MAX_ATTEMPTS, PUSH_QUEUE_TTL_MS, type Deps, type Env } from "./env.js";

/** Contenu d'une notification, même forme que celles du hub et de l'ERP. */
export type PushPayload = { title: string; body: string; url: string; tag: string };

const SCREEN = "/surveillance";

/** Durée lisible : « 12 min », « 2 h 05 », « 3 j 4 h ». */
export function formatDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${String(min % 60).padStart(2, "0")}`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} j ${h % 24} h` : `${d} j`;
}

export type Opening = { targetId: string; label: string; reason: string | null; basis: Observer[] };
export type Recovery = { targetId: string; label: string; startedAt: number };
export type Reminder = { targetId: string; label: string; startedAt: number; incidentId: number };

const names = (labels: string[]) => {
  const shown = labels.slice(0, GROUP_ALERT_THRESHOLD).join(", ");
  const more = labels.length - GROUP_ALERT_THRESHOLD;
  return more > 0 ? `${shown} et ${more} autre${more > 1 ? "s" : ""}` : shown;
};

/** Anti-rafale : au-delà de 3 cibles dans le même cycle, une seule notification groupée par type. */
export function buildNotifications(now: number, openings: Opening[], recoveries: Recovery[], reminders: Reminder[]): PushPayload[] {
  const out: PushPayload[] = [];
  if (openings.length > GROUP_ALERT_THRESHOLD) {
    out.push({
      title: `${openings.length} sites en panne`,
      body: `${names(openings.map((o) => o.label))} ne répondent plus.`,
      url: SCREEN,
      tag: `panne-groupe-${now}`,
    });
  } else {
    for (const o of openings) {
      const seen = o.basis.length === 2 ? "Vu par le hub et par Cloudflare." : "Vu par Cloudflare seulement : le hub ne répond pas.";
      out.push({
        title: `Site en panne : ${o.label}`,
        body: `${o.label} ne répond plus${o.reason ? ` (${o.reason})` : ""}. ${seen}`,
        url: SCREEN,
        tag: `incident-${o.targetId}`,
      });
    }
  }
  if (recoveries.length > GROUP_ALERT_THRESHOLD) {
    out.push({
      title: `${recoveries.length} sites rétablis`,
      body: `${names(recoveries.map((r) => r.label))} répondent de nouveau.`,
      url: SCREEN,
      tag: `retour-groupe-${now}`,
    });
  } else {
    for (const r of recoveries) {
      out.push({
        title: `Site rétabli : ${r.label}`,
        body: `${r.label} répond de nouveau, après ${formatDuration(now - r.startedAt)} de panne.`,
        url: SCREEN,
        tag: `incident-${r.targetId}`,
      });
    }
  }
  if (reminders.length > GROUP_ALERT_THRESHOLD) {
    out.push({
      title: `${reminders.length} sites toujours en panne`,
      body: `${names(reminders.map((r) => r.label))} ne répondent toujours pas.`,
      url: SCREEN,
      tag: `rappel-groupe-${now}`,
    });
  } else {
    for (const r of reminders) {
      out.push({
        title: `Toujours en panne : ${r.label}`,
        body: `${r.label} ne répond plus depuis ${formatDuration(now - r.startedAt)}.`,
        url: SCREEN,
        tag: `incident-${r.targetId}`,
      });
    }
  }
  return out;
}

export const hubOfflineNotification = (): PushPayload => ({
  title: "Hub hors ligne",
  body: "Le hub ou la box ne donne plus signe de vie depuis 15 min. Cloudflare continue de surveiller les sites seul.",
  url: SCREEN,
  tag: "hub-hors-ligne",
});

export const hubBackNotification = (now: number, offlineSince: number): PushPayload => ({
  title: "Hub de nouveau en ligne",
  body: `Le hub donne de nouveau signe de vie, après ${formatDuration(now - offlineSince)} hors ligne.`,
  url: SCREEN,
  tag: "hub-hors-ligne",
});

/** Ajout à la file : une ligne par notification et par appareil abonné (une seule requête). */
export function enqueueStatement(env: Env, now: number, payloads: PushPayload[]) {
  return env.DB.prepare(
    "INSERT INTO push_queue (created_at, endpoint, payload) SELECT ?1, s.endpoint, n.value FROM subscriptions s, json_each(?2) n",
  ).bind(now, JSON.stringify(payloads.map((p) => JSON.stringify(p))));
}

/** Sujet de remplacement (32 caractères base64url au plus) : une même alerte ne s'empile pas. */
function topicOf(tag: string): string {
  const bytes = new TextEncoder().encode(tag);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 32);
}

export function vapidConfig(env: Env): { subject: string; publicKey: string; privateKey: string } | null {
  const subject = env.VAPID_SUBJECT?.trim();
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (!subject || !publicKey || !privateKey || !/^(mailto:|https:\/\/)/.test(subject)) return null;
  return { subject, publicKey, privateKey };
}

type QueueRow = { id: number; payload: string; attempts: number; endpoint: string; p256dh: string; auth: string };

export type FlushReport = { sent: number; gone: number; failed: number };

/**
 * Envoie au plus `cap` notifications de la file. 2xx : retirée ; 404 ou 410 : l'appareil s'est
 * désabonné, abonnement et file retirés ; autre échec : nouvel essai au passage suivant, abandon après
 * PUSH_MAX_ATTEMPTS essais ou PUSH_QUEUE_TTL_MS.
 */
export async function flushQueue(env: Env, deps: Deps, now: number, cap: number): Promise<FlushReport> {
  const report: FlushReport = { sent: 0, gone: 0, failed: 0 };
  const vapid = vapidConfig(env);
  if (!vapid || cap <= 0) return report;
  const { results } = await env.DB.prepare(
    "SELECT q.id, q.payload, q.attempts, s.endpoint, s.p256dh, s.auth FROM push_queue q JOIN subscriptions s ON s.endpoint = q.endpoint ORDER BY q.id LIMIT ?1",
  )
    .bind(cap)
    .all<QueueRow>();
  if (results.length === 0) return report;

  const done: number[] = [];
  const retry: number[] = [];
  const goneEndpoints: string[] = [];
  for (const row of results) {
    const payload = JSON.parse(row.payload) as PushPayload;
    try {
      const req = await buildPushPayload(
        { data: payload, options: { ttl: 24 * 3600, urgency: "high", topic: topicOf(payload.tag) } },
        { endpoint: row.endpoint, expirationTime: null, keys: { p256dh: row.p256dh, auth: row.auth } },
        vapid,
      );
      const res = await deps.fetch(row.endpoint, { method: req.method, headers: req.headers, body: req.body });
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) {
        done.push(row.id);
        report.sent += 1;
      } else if (res.status === 404 || res.status === 410) {
        done.push(row.id);
        goneEndpoints.push(row.endpoint);
        report.gone += 1;
      } else {
        retry.push(row.id);
        report.failed += 1;
      }
    } catch {
      retry.push(row.id);
      report.failed += 1;
    }
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM push_queue WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(done)),
    env.DB.prepare("UPDATE push_queue SET attempts = attempts + 1 WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(retry)),
    env.DB.prepare("DELETE FROM subscriptions WHERE endpoint IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(goneEndpoints)),
    env.DB.prepare(
      "DELETE FROM push_queue WHERE attempts >= ?1 OR created_at < ?2 OR endpoint NOT IN (SELECT endpoint FROM subscriptions)",
    ).bind(PUSH_MAX_ATTEMPTS, now - PUSH_QUEUE_TTL_MS),
  ]);
  return report;
}
