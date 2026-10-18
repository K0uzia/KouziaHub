import { createECDH, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { verifyRequest, type HttpObservation, type StateResponse, type SyncBody, type ReportBody } from "@/lib/monitor/core.js";
import type { DnsResolver, PeerInfo } from "@/lib/monitor/checks.js";
import { RdapClient } from "@/lib/monitor/checks.js";
import { MonitorService } from "@/lib/monitor/service.js";
import { HttpVeilleClient, NoVeilleClient, type VeilleClient } from "@/lib/monitor/worker-client.js";
import { PushService, type PushPayload } from "@/lib/push/service.js";
import { generateVapidKeys } from "@/lib/push/vapid.js";
import { prisma, resetDb } from "../helpers/db.js";
import { createAdmin } from "../helpers/auth.js";

class RecordingPush extends PushService {
  readonly sent: PushPayload[] = [];
  constructor() {
    super({ vapid: null });
  }
  override async sendToAll(payload: PushPayload) {
    this.sent.push(payload);
    return { sent: 1, failed: 0, removed: 0 };
  }
}

class FakeVeille implements VeilleClient {
  readonly configured = true;
  syncs: Array<Omit<SyncBody, "v">> = [];
  reports: Array<Omit<ReportBody, "v">> = [];
  edgeSeenAt: number | null = null;
  observations: HttpObservation[] = [];
  async sync(body: Omit<SyncBody, "v">) {
    this.syncs.push(body);
  }
  async report(body: Omit<ReportBody, "v">) {
    this.reports.push(body);
  }
  async state(since: number): Promise<StateResponse> {
    return { v: 1, now: Date.now(), edgeSeenAt: this.edgeSeenAt, hubSeenAt: null, observations: this.observations.filter((o) => o.at > since), incidents: [] };
  }
}

const MIN = 60_000;
const DAY = 86_400_000;
let t: number;
let status: Map<string, number>;
let push: RecordingPush;

const fetchFor = (async (input: string | URL | Request) => {
  const url = String(input);
  const s = status.get(url) ?? 200;
  return new Response(`<html><p>${url}</p></html>`, { status: s });
}) as typeof fetch;

function service(veille: VeilleClient = new NoVeilleClient(), extra: Partial<ConstructorParameters<typeof MonitorService>[0]> = {}) {
  return new MonitorService({
    push,
    veille,
    fetch: fetchFor,
    now: () => t,
    speed: async () => ({ available: false, reason: "test" }),
    ...extra,
  });
}

async function target(host: string, extra: Record<string, unknown> = {}) {
  return prisma.monitorTarget.create({ data: { url: `https://${host}/`, hostname: host, label: host, source: "manual", ...extra } });
}

beforeEach(async () => {
  await resetDb();
  t = Date.parse("2026-10-18T10:00:00Z");
  status = new Map();
  push = new RecordingPush();
});

describe("décision et incidents, hub seul (Worker non configuré)", () => {
  it("panne sur 2 échecs, notification urgente qui le dit, retour avec la durée, rappel à 24 h", async () => {
    const m = service();
    const a = await target("a.fr");
    status.set(a.url, 503);
    await m.runHttpCycle();
    expect(await prisma.monitorIncident.count()).toBe(0);
    t += 5 * MIN;
    await m.runHttpCycle();
    const incident = await prisma.monitorIncident.findFirstOrThrow();
    expect(incident).toMatchObject({ cause: "statut 503", observers: "hub", endedAt: null });
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]).toMatchObject({ title: "Panne : a.fr", urgent: true, body: expect.stringMatching(/hub seul : surveillance Cloudflare non configurée/) });

    // Panne ouverte depuis 24 h (contrôles toutes les 5 min entre-temps) : rappel, une seule fois.
    await prisma.monitorIncident.update({ where: { id: incident.id }, data: { startedAt: new Date(t - DAY) } });
    t += 5 * MIN;
    await m.runHttpCycle();
    expect(push.sent.at(-1)!.title).toBe("Toujours en panne : a.fr");
    t += 5 * MIN;
    await m.runHttpCycle();
    expect(push.sent).toHaveLength(2);

    status.delete(a.url);
    t += 5 * MIN;
    await m.runHttpCycle();
    expect(push.sent.at(-1)).toMatchObject({ title: "Rétabli : a.fr", body: expect.stringMatching(/après 24 h 15 min/) });
    expect((await prisma.monitorIncident.findFirstOrThrow()).endedAt).not.toBeNull();
  });

  it("plus de 3 cibles en panne dans le même cycle : une seule notification groupée", async () => {
    const m = service();
    for (const h of ["a.fr", "b.fr", "c.fr", "d.fr"]) status.set((await target(h)).url, 500);
    await m.runHttpCycle();
    t += 5 * MIN;
    await m.runHttpCycle();
    expect(await prisma.monitorIncident.count()).toBe(4);
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.title).toBe("4 sites en panne");
  });

  it("une version de travail d'un site coupé n'est pas contrôlée (off voulu)", async () => {
    await createAdmin();
    const site = await prisma.site.create({ data: { slug: "alpha", kind: "PERSO", label: "A", pagesProject: "kz-alpha", state: "OFFLINE" } });
    await target("alpha.kouzia.com", { siteId: site.id, siteRole: "working", source: "site" });
    const m = service();
    expect(await m.activeTargets()).toEqual([]);
  });
});

describe("décision avec les observations du Worker", () => {
  it("Worker vivant : panne vue des deux côtés, incident pour l'historique, aucune alerte urgente du hub", async () => {
    const veille = new FakeVeille();
    const m = service(veille);
    const a = await target("a.fr");
    status.set(a.url, 503);
    veille.edgeSeenAt = t;
    veille.observations = [
      { targetId: a.id, observer: "edge", at: t - 4 * MIN, ok: false, status: 503, ms: 80, reason: "statut 503" },
      { targetId: a.id, observer: "edge", at: t - MIN, ok: false, status: 503, ms: 80, reason: "statut 503" },
    ];
    await m.runHttpCycle();
    t += 5 * MIN;
    veille.edgeSeenAt = t;
    await m.runHttpCycle();
    expect(await prisma.monitorIncident.findFirstOrThrow()).toMatchObject({ observers: "hub,edge", notifiedAt: null });
    expect(push.sent).toEqual([]);
    expect(veille.reports).toHaveLength(2);
    expect(veille.reports[0]!.observations).toEqual([expect.objectContaining({ targetId: a.id, observer: "hub", ok: false, status: 503 })]);
    expect(await prisma.monitorCheck.count({ where: { observer: "edge" } })).toBe(2);
  });

  it("cible stable côté Worker (dernière ligne ancienne, Worker vivant) : son état reste le succès", async () => {
    const veille = new FakeVeille();
    const m = service(veille);
    const a = await target("a.fr");
    await prisma.monitorCheck.create({ data: { targetId: a.id, kind: "http", observer: "edge", at: new Date(t - 3 * 3_600_000), ok: true, status: 200, ms: 40 } });
    m.health.lastStateSince = t - 3 * 3_600_000;
    status.set(a.url, 503);
    veille.edgeSeenAt = t;
    await m.runHttpCycle();
    t += 5 * MIN;
    veille.edgeSeenAt = t;
    await m.runHttpCycle();
    expect(m.decideFor((await m.recentChecks([a.id])).get(a.id))).toEqual({ verdict: "local_only", basis: ["hub", "edge"] });
    expect(await prisma.monitorIncident.count()).toBe(0);
  });

  it("échec vu par le hub seulement : problème local, ni incident ni alerte", async () => {
    const veille = new FakeVeille();
    const m = service(veille);
    const a = await target("a.fr");
    status.set(a.url, 503);
    veille.edgeSeenAt = t;
    veille.observations = [{ targetId: a.id, observer: "edge", at: t - MIN, ok: true, status: 200, ms: 50, reason: null }];
    await m.runHttpCycle();
    t += 5 * MIN;
    veille.edgeSeenAt = t;
    veille.observations.push({ targetId: a.id, observer: "edge", at: t - MIN, ok: true, status: 200, ms: 50, reason: null });
    await m.runHttpCycle();
    expect(m.decideFor((await m.recentChecks([a.id])).get(a.id)).verdict).toBe("local_only");
    expect(await prisma.monitorIncident.count()).toBe(0);
    expect(push.sent).toEqual([]);
  });

  it("Worker muet depuis 15 min : « surveillance Cloudflare interrompue » une seule fois, puis le hub alerte seul", async () => {
    const veille = new FakeVeille();
    const m = service(veille);
    const a = await target("a.fr");
    veille.edgeSeenAt = t - 20 * MIN;
    await m.runHttpCycle();
    t += 5 * MIN;
    await m.runHttpCycle();
    expect(push.sent.filter((p) => p.title === "Surveillance Cloudflare interrompue")).toHaveLength(1);
    status.set(a.url, 503);
    t += 5 * MIN;
    await m.runHttpCycle();
    t += 5 * MIN;
    await m.runHttpCycle();
    expect(push.sent.at(-1)).toMatchObject({ title: "Panne : a.fr", body: expect.stringMatching(/surveillance Cloudflare interrompue/) });
  });
});

describe("contrôles quotidiens : seuils et anti-rafale", () => {
  const peerExpiring = (days: number): PeerInfo => ({
    cert: {
      valid_to: new Date(t + days * DAY + 3_600_000).toUTCString(),
      issuer: { O: "Let's Encrypt" } as PeerInfo["cert"]["issuer"],
      subject: { CN: "a.fr" } as PeerInfo["cert"]["subject"],
      subjectaltname: "DNS:a.fr",
    },
    authorized: true,
    authorizationError: null,
  });

  it("certificat : alertes à 30, 14 et 7 jours, une fois chacune ; seuils franchis ensemble : une seule", async () => {
    const start = t;
    const fixed = peerExpiring(20);
    const m = service(new NoVeilleClient(), { tls: async () => fixed });
    const a = await target("a.fr");
    await m.checkTls(a);
    await m.checkTls(a);
    expect(push.sent.map((p) => p.title)).toEqual(["Le certificat expire dans 20 jours"]);
    for (const day of [10, 11, 15]) {
      t = start + day * DAY;
      await m.checkTls(a);
    }
    expect(push.sent.map((p) => p.title)).toEqual(["Le certificat expire dans 20 jours", "Le certificat expire dans 10 jours", "Le certificat expire dans 5 jours"]);

    // Premier contrôle à 10 jours : seuils 30 et 14 franchis ensemble, une seule notification.
    push.sent.length = 0;
    t = start;
    const b = await target("b.fr");
    const tenDays = { ...peerExpiring(10), cert: { ...peerExpiring(10).cert, subjectaltname: "DNS:b.fr", subject: { CN: "b.fr" } as PeerInfo["cert"]["subject"] } };
    const m2 = service(new NoVeilleClient(), { tls: async () => tenDays });
    await m2.checkTls(b);
    t = start + 2 * DAY;
    await m2.checkTls(b);
    expect(push.sent.map((p) => p.title)).toEqual(["Le certificat expire dans 10 jours"]);
    expect(await prisma.monitorAlert.count({ where: { targetId: b.id } })).toBe(2);
  });

  it("certificat invalide : alerte immédiate, une seule fois", async () => {
    const m = service(new NoVeilleClient(), { tls: async () => ({ ...peerExpiring(60), authorized: false, authorizationError: "CERT_UNTRUSTED" }) });
    const a = await target("a.fr");
    await m.checkTls(a);
    await m.checkTls(a);
    expect(push.sent).toEqual([expect.objectContaining({ title: "Certificat invalide : a.fr" })]);
  });

  it("domaine : seuil d'échéance par RDAP ; échéance inconnue : aucune alerte", async () => {
    const rdapFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("iana")) return Response.json({ services: [[["fr"], ["https://rdap.nic.fr/"]]] });
      if (url.endsWith("/a.fr")) return Response.json({ events: [{ eventAction: "expiration", eventDate: new Date(t + 6 * DAY + 3_600_000).toISOString() }] });
      return Response.json({ events: [] });
    }) as typeof fetch;
    const m = service(new NoVeilleClient(), { rdap: new RdapClient({ fetch: rdapFetch, now: () => t }) });
    await m.checkDomain(await target("a.fr"));
    await m.checkDomain(await target("b.fr"));
    expect(push.sent.map((p) => p.title)).toEqual(["Le nom de domaine expire dans 6 jours"]);
    const unknown = await prisma.monitorCheck.findFirstOrThrow({ where: { kind: "domain", target: { hostname: "b.fr" } } });
    expect(JSON.parse(unknown.detail!)).toMatchObject({ expiresAt: null });
  });

  it("DNS : sans référence pas d'alerte ; référence acceptée ; écart notifié une fois (non urgent)", async () => {
    let a4 = ["192.0.2.1"];
    const resolver: DnsResolver = {
      resolve4: async () => a4,
      resolve6: async () => [],
      resolveCname: async () => [],
      resolveNs: async () => ["ns1.exemple.net"],
      resolveMx: async () => [],
    };
    const m = service(new NoVeilleClient(), { resolver });
    const a = await target("a.fr");
    await m.checkDns(a);
    expect(push.sent).toEqual([]);
    await m.acceptDns(a);
    const fresh = await prisma.monitorTarget.findUniqueOrThrow({ where: { id: a.id } });
    a4 = ["198.51.100.9"];
    await m.checkDns(fresh);
    await m.checkDns(fresh);
    expect(push.sent).toEqual([expect.objectContaining({ title: "DNS modifié : a.fr", body: expect.stringMatching(/A\./) })]);
    expect(push.sent[0]!.urgent).toBeFalsy();
  });

  it("contenu : changement inattendu = notification non urgente, jamais une panne ; nouvelle référence acceptée", async () => {
    const m = service();
    const a = await target("a.fr");
    await m.checkContent(a);
    expect(push.sent).toEqual([]);
    await m.acceptContent(a);
    await prisma.monitorTarget.update({ where: { id: a.id }, data: { contentHash: "0".repeat(64) } });
    const changed = await prisma.monitorTarget.findUniqueOrThrow({ where: { id: a.id } });
    await m.checkContent(changed);
    await m.checkContent(changed);
    expect(push.sent).toEqual([expect.objectContaining({ title: "Accueil modifié : a.fr" })]);
    expect(push.sent[0]!.urgent).toBeFalsy();
    expect(await prisma.monitorIncident.count()).toBe(0);
  });
});

describe("historique", () => {
  it("agrégats horaires par point de contrôle (moyenne et p95)", async () => {
    const a = await target("a.fr");
    const hour = Date.parse("2026-10-18T10:00:00Z");
    const rows = [100, 200, 300, 400, null].map((ms, i) => ({
      targetId: a.id,
      kind: "http",
      observer: "hub",
      at: new Date(hour + i * 5 * MIN),
      ok: ms !== null,
      status: ms !== null ? 200 : null,
      ms,
    }));
    await prisma.monitorCheck.createMany({ data: rows });
    await service().aggregate([a.id], hour + 40 * MIN);
    const hub = await prisma.monitorHourly.findFirstOrThrow({ where: { observer: "hub" } });
    expect(hub).toMatchObject({ checks: 5, failures: 1, avgMs: 250, p95Ms: 400 });
    expect(await prisma.monitorHourly.count({ where: { observer: "edge" } })).toBe(0);
  });

  it("Worker : heure reconstituée depuis les seuls changements d'état, jusqu'à edgeSeenAt", async () => {
    const a = await target("a.fr");
    const hour = Date.parse("2026-10-18T10:00:00Z");
    const edge = (min: number, ok: boolean) => ({ targetId: a.id, kind: "http", observer: "edge", at: new Date(hour + min * MIN), ok, status: ok ? 200 : 503, ms: ok ? 60 : null });
    // Stable en succès depuis 9 h 50 (aucune ligne ensuite), deux échecs à 10 h 20 et 10 h 25, retour à 10 h 30.
    await prisma.monitorCheck.createMany({ data: [edge(-10, true), edge(20, false), edge(25, false), edge(30, true)] });
    const m = service(new FakeVeille());
    m.health.edgeSeenAt = hour + 60 * MIN;
    await m.aggregate([a.id], hour + 61 * MIN);
    expect(await prisma.monitorHourly.findFirstOrThrow({ where: { observer: "edge", hour: new Date(hour) } })).toMatchObject({ checks: 12, failures: 2 });
  });

  it("purge : HTTP brut au-delà de 7 jours, le reste au-delà de 13 mois", async () => {
    const a = await target("a.fr");
    const old = (days: number) => new Date(t - days * DAY);
    await prisma.monitorCheck.createMany({
      data: [
        { targetId: a.id, kind: "http", observer: "hub", at: old(8), ok: true },
        { targetId: a.id, kind: "http", observer: "hub", at: old(6), ok: true },
        { targetId: a.id, kind: "tls", observer: "hub", at: old(200), ok: true },
        { targetId: a.id, kind: "tls", observer: "hub", at: old(400), ok: true },
      ],
    });
    await prisma.monitorHourly.createMany({
      data: [
        { targetId: a.id, hour: old(300), observer: "hub", checks: 1, failures: 0 },
        { targetId: a.id, hour: old(420), observer: "hub", checks: 1, failures: 0 },
      ],
    });
    await prisma.monitorIncident.create({ data: { targetId: a.id, startedAt: old(500), endedAt: old(499), observers: "hub" } });
    await service().purge();
    expect(await prisma.monitorCheck.count({ where: { kind: "http" } })).toBe(1);
    expect(await prisma.monitorCheck.count({ where: { kind: "tls" } })).toBe(1);
    expect(await prisma.monitorHourly.count()).toBe(1);
    expect(await prisma.monitorIncident.count()).toBe(0);
  });
});

describe("échange signé avec le Worker (fetch injecté)", () => {
  const SECRET = "secret-partage-veille-de-test";

  it("POST /sync et /report signés, GET /state signé sur le chemin seul", async () => {
    const received: Array<{ method: string; path: string; body: string; ok: boolean }> = [];
    const workerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? init.body : "";
      const ok = await verifyRequest(
        SECRET,
        { timestamp: headers.get("x-kouzia-veille-timestamp"), signature: headers.get("x-kouzia-veille-signature") },
        init?.method ?? "GET",
        url.pathname,
        body,
        Date.now(),
      );
      received.push({ method: init?.method ?? "GET", path: url.pathname + url.search, body, ok });
      if (!ok) return new Response("Not found", { status: 404 });
      if (url.pathname === "/state") {
        return Response.json({ v: 1, now: Date.now(), edgeSeenAt: Date.now(), hubSeenAt: null, observations: [], incidents: [] } satisfies StateResponse);
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const veille = new HttpVeilleClient({ url: "https://kouzia-veille.exemple.workers.dev", secret: SECRET, fetch: workerFetch });
    await createAdmin();
    const user = await prisma.user.findFirstOrThrow();
    await prisma.pushSubscription.create({ data: { userId: user.id, endpoint: "https://push.exemple/abc", p256dh: "p".repeat(20), auth: "a".repeat(10), label: "Téléphone" } });
    const a = await target("a.fr", { keyword: "Bienvenue" });
    await target("b.fr", { enabled: false });
    t = Date.now();
    const m = new MonitorService({ push: new PushService({ vapid: null }), veille, fetch: fetchFor, now: () => t });
    await m.requestSync();
    await m.runHttpCycle();
    expect(received.map((r) => `${r.method} ${r.path} ${r.ok}`)).toEqual(["POST /sync true", "POST /report true", `GET /state?since=0 true`]);
    const sync = JSON.parse(received[0]!.body) as SyncBody;
    expect(sync).toEqual({
      v: 1,
      targets: [{ id: a.id, label: "a.fr", url: "https://a.fr/", keyword: "Bienvenue" }],
      subscriptions: [{ endpoint: "https://push.exemple/abc", keys: { p256dh: "p".repeat(20), auth: "a".repeat(10) } }],
    });
    const report = JSON.parse(received[1]!.body) as ReportBody;
    expect(report).toMatchObject({ v: 1, at: t, observations: [expect.objectContaining({ targetId: a.id, observer: "hub" })] });
    expect(m.health).toMatchObject({ error: null, lastSyncAt: t });
  });

  it("signature refusée (mauvais secret) : erreur affichable, aucun plantage", async () => {
    const workerFetch = (async () => new Response("Not found", { status: 404 })) as typeof fetch;
    const m = new MonitorService({ push: new PushService({ vapid: null }), veille: new HttpVeilleClient({ url: "https://v.workers.dev", secret: "x", fetch: workerFetch }), fetch: fetchFor });
    await m.requestSync();
    expect(m.health.error).toMatch(/signature refusée/);
  });
});

describe("Web Push (fetch factice)", () => {
  const vapid = { ...generateVapidKeys(), subject: "mailto:test@exemple.fr" };
  const browserKeys = () => {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    return { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
  };

  it("chiffre et envoie, met à jour le dernier succès ; 410 retire l'abonnement", async () => {
    await createAdmin();
    const user = await prisma.user.findFirstOrThrow();
    const ok = await prisma.pushSubscription.create({ data: { userId: user.id, endpoint: "https://push.exemple/ok", ...browserKeys(), label: "A" } });
    await prisma.pushSubscription.create({ data: { userId: user.id, endpoint: "https://push.exemple/gone", ...browserKeys(), label: "B" } });
    const calls: Array<{ url: string; headers: Headers; size: number }> = [];
    const pushFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers), size: (init?.body as ArrayBuffer | Uint8Array | undefined)?.byteLength ?? 0 });
      return new Response(null, { status: url.endsWith("/gone") ? 410 : 201 });
    }) as typeof fetch;
    const service = new PushService({ fetch: pushFetch, vapid });
    const report = await service.sendToAll({ title: "Panne : a.fr", body: "statut 503", url: "/surveillance", tag: "incident:1", urgent: true });
    expect(report).toEqual({ sent: 1, failed: 0, removed: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers.get("content-encoding")).toBe("aes128gcm");
    expect(calls[0]!.headers.get("authorization")).toMatch(/^vapid t=/);
    expect(calls[0]!.headers.get("urgency")).toBe("high");
    expect(calls[0]!.size).toBeGreaterThan(100);
    expect(await prisma.pushSubscription.findMany({ select: { endpoint: true } })).toEqual([{ endpoint: "https://push.exemple/ok" }]);
    expect((await prisma.pushSubscription.findUniqueOrThrow({ where: { id: ok.id } })).lastSuccessAt).not.toBeNull();
  });

  it("sans clés VAPID : rien n'est envoyé", async () => {
    expect(await new PushService({ vapid: null }).sendToAll({ title: "x", body: "y", url: "/" })).toEqual({ sent: 0, failed: 0, removed: 0 });
  });
});
