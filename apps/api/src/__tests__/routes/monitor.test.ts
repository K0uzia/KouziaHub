import { createECDH, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CatalogResponse, MonitorOverview, MonitorTargetDetail, MonitorTargetEntry, PushDevice, SiteDetail } from "@/contract.js";
import { FakeZonesDirectory, RealZonesDirectory } from "@/lib/cloudflare/zones.js";
import type { PeerInfo } from "@/lib/monitor/checks.js";
import { PushService } from "@/lib/push/service.js";
import { generateVapidKeys } from "@/lib/push/vapid.js";
import { prisma, resetDb } from "../helpers/db.js";
import { buildTestHub, createPersoSite, settle, type TestHub } from "../helpers/hub.js";

let hub: TestHub;
let t: number;
const status = new Map<string, number>();
const pushCalls: string[] = [];

const siteFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  return new Response(`<html><h1>${url}</h1></html>`, { status: status.get(url) ?? 200 });
}) as typeof fetch;
const pushFetch = (async (input: string | URL | Request) => {
  pushCalls.push(String(input));
  return new Response(null, { status: String(input).endsWith("/expire") ? 410 : 201 });
}) as typeof fetch;
const peer = (host: string, days: number): PeerInfo => ({
  cert: {
    valid_to: new Date(t + days * 86_400_000 + 3_600_000).toUTCString(),
    issuer: { O: "Let's Encrypt" } as PeerInfo["cert"]["issuer"],
    subject: { CN: host } as PeerInfo["cert"]["subject"],
    subjectaltname: `DNS:${host}`,
  },
  authorized: true,
  authorizationError: null,
});

beforeEach(async () => {
  await resetDb();
  status.clear();
  pushCalls.length = 0;
  t = Date.now();
  hub = await buildTestHub({
    monitor: { fetch: siteFetch, now: () => t, tls: async (host) => peer(host, 12), connectivity: async () => true },
    push: new PushService({ fetch: pushFetch, vapid: { ...generateVapidKeys(), subject: "mailto:test@exemple.fr" } }),
    zones: new FakeZonesDirectory(["client-exemple.fr", "autre.fr"]),
  });
});
afterEach(async () => {
  await hub.app.close();
});

const get = async <T>(url: string) => {
  const res = await hub.app.inject({ method: "GET", url, headers: hub.headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as T;
};
const send = (method: "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  hub.app.inject({ method, url, headers: hub.headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe("cibles des sites", () => {
  it("la création d'un site crée sa cible (version de travail) ; le domaine final en ajoute une ; le badge du catalogue est rempli", async () => {
    const id = await createPersoSite(hub, "alpha");
    let targets = await get<MonitorTargetEntry[]>(`/api/sites/${id}/monitor`);
    expect(targets).toEqual([expect.objectContaining({ url: "https://alpha.kouzia.com/", source: "site", enabled: true, siteSlug: "alpha", label: "alpha.kouzia.com (version de travail)" })]);

    await send("PATCH", `/api/sites/${id}`, { finalDomain: "client-exemple.fr", canonicalHost: "www" });
    targets = await get<MonitorTargetEntry[]>(`/api/sites/${id}/monitor`);
    expect(targets.map((x) => x.url)).toEqual(["https://alpha.kouzia.com/", "https://www.client-exemple.fr/"]);
    await send("PATCH", `/api/sites/${id}`, { canonicalHost: "apex" });
    expect((await get<MonitorTargetEntry[]>(`/api/sites/${id}/monitor`)).map((x) => x.url)).toContain("https://client-exemple.fr/");

    await hub.services.monitor.runHttpCycle();
    await hub.services.monitor.runDueSlowChecks();
    const catalog = await get<CatalogResponse>("/api/sites");
    expect(catalog.sites[0]!.monitor).toMatchObject({ verdict: "up", watched: 2, openIncidentSince: null, expiresInDays: 12 });
    const detail = await get<SiteDetail>(`/api/sites/${id}`);
    expect(detail.monitor?.watched).toBe(2);

    await send("PATCH", `/api/sites/${id}`, { finalDomain: null });
    expect(await get<MonitorTargetEntry[]>(`/api/sites/${id}/monitor`)).toHaveLength(1);
  });

  it("site coupé : sa version de travail n'est plus surveillée (pas d'alerte pour un off voulu)", async () => {
    const id = await createPersoSite(hub, "alpha");
    await send("POST", `/api/sites/${id}/disable`);
    await settle(hub);
    expect(await hub.services.monitor.activeTargets()).toEqual([]);
    expect((await get<CatalogResponse>("/api/sites")).sites[0]!.monitor).toBeNull();
  });

  it("une cible de site ne se supprime pas (interrupteur seulement) ; suppression du site : cibles retirées", async () => {
    const id = await createPersoSite(hub, "alpha");
    const [target] = await get<MonitorTargetEntry[]>(`/api/sites/${id}/monitor`);
    expect((await send("DELETE", `/api/monitor/targets/${target!.id}`)).statusCode).toBe(409);
    const off = await send("PATCH", `/api/monitor/targets/${target!.id}`, { enabled: false });
    expect(off.json()).toMatchObject({ enabled: false, verdict: "unknown" });
    await send("DELETE", `/api/sites/${id}`, { confirm: "alpha" });
    await settle(hub);
    expect(await prisma.monitorTarget.count()).toBe(0);
  });
});

describe("domaines ajoutés à la main et zones Cloudflare", () => {
  it("ajout, contrôle immédiat, modification, suppression, audit", async () => {
    const created = await send("POST", "/api/monitor/targets", { url: "www.client-exemple.fr", label: "Client exemple", keyword: "Bienvenue", erpClientId: "demo-01" });
    expect(created.statusCode).toBe(201);
    const entry = created.json() as MonitorTargetEntry;
    expect(entry).toMatchObject({ url: "https://www.client-exemple.fr/", hostname: "www.client-exemple.fr", source: "manual", clientName: "Exemple 01 : boulangerie" });
    expect((await send("POST", "/api/monitor/targets", { url: "https://www.client-exemple.fr/", label: "x" })).statusCode).toBe(409);
    for (const bad of ["ftp://a.fr", "https://user:pw@a.fr", "pas une adresse", "https://localhost/", "https://nas.lan/", "https://pve.local/", "https://box.internal/", "https://routeur.home.arpa/", "https://ct.localhost/", "http://192.168.1.10:3100/", "http://[::ffff:127.0.0.1]/"]) {
      expect((await send("POST", "/api/monitor/targets", { url: bad, label: "x" })).statusCode, bad).toBe(400);
    }
    status.set("https://www.client-exemple.fr/", 503);
    const checked = (await send("POST", `/api/monitor/targets/${entry.id}/check`)).json() as MonitorTargetEntry;
    expect(checked.lastHub).toMatchObject({ ok: false, status: 503, reason: "statut 503" });
    const patched = (await send("PATCH", `/api/monitor/targets/${entry.id}`, { label: "Client", keyword: null })).json() as MonitorTargetEntry;
    expect(patched).toMatchObject({ label: "Client", keyword: null });
    expect((await send("DELETE", `/api/monitor/targets/${entry.id}`)).json()).toEqual({ ok: true });
    const actions = (await prisma.auditEvent.findMany({ where: { action: { startsWith: "monitor." } } })).map((a) => a.action).sort();
    expect(actions).toEqual(["monitor.target.create", "monitor.target.delete", "monitor.target.update"]);
  });

  it("zones Cloudflare proposées, déjà surveillées signalées, ajout d'une zone", async () => {
    await send("POST", "/api/monitor/targets", { url: "https://www.autre.fr/", label: "Autre" });
    const zones = await get<{ available: boolean; zones: Array<{ name: string; alreadyWatched: boolean }> }>("/api/monitor/zones");
    expect(zones).toEqual({ available: true, zones: [{ name: "autre.fr", alreadyWatched: true }, { name: "client-exemple.fr", alreadyWatched: false }] });
    const watch = await send("POST", "/api/monitor/zones/client-exemple.fr/watch");
    expect(watch.statusCode).toBe(201);
    expect(watch.json()).toMatchObject({ url: "https://client-exemple.fr/", source: "cloudflare" });
    expect((await send("POST", "/api/monitor/zones/client-exemple.fr/watch")).statusCode).toBe(409);
    expect((await send("POST", "/api/monitor/zones/inconnu.fr/watch")).statusCode).toBe(404);
  });

  it("adaptateur réel des zones : GET /zones paginé, jeton séparé, aucun réseau", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const zonesFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url: url.pathname + url.search, auth: new Headers(init?.headers).get("authorization") });
      const page = Number(url.searchParams.get("page"));
      const result = page === 1 ? Array.from({ length: 50 }, (_, i) => ({ name: `z${String(i).padStart(2, "0")}.fr` })) : [{ name: "Derniere.FR" }];
      return Response.json({ success: true, result, result_info: { total_pages: 2 } });
    }) as typeof fetch;
    const zones = await new RealZonesDirectory({ token: "jeton-zones-test", fetch: zonesFetch }).listZones();
    expect(zones).toHaveLength(51);
    expect(zones).toContain("derniere.fr");
    expect(calls).toEqual([
      { url: "/client/v4/zones?per_page=50&page=1", auth: "Bearer jeton-zones-test" },
      { url: "/client/v4/zones?per_page=50&page=2", auth: "Bearer jeton-zones-test" },
    ]);
    const denied = new RealZonesDirectory({ token: "x", fetch: (async () => Response.json({ success: false }, { status: 403 })) as typeof fetch });
    await expect(denied.listZones()).rejects.toThrow(/Zone Read/);
  });
});

describe("écran Surveillance, détail, rapport", () => {
  it("vue d'ensemble, détail avec historique et rapport PDF en pièce jointe", async () => {
    const created = (await send("POST", "/api/monitor/targets", { url: "https://client-exemple.fr/", label: "Client exemple" })).json() as MonitorTargetEntry;
    await hub.services.monitor.runHttpCycle();
    t += 60_000;
    const overview = await get<MonitorOverview>("/api/monitor");
    expect(overview.stats).toMatchObject({ watched: 1, up: 1, down: 0, openIncidents: 0 });
    expect(overview.health).toMatchObject({ edge: { configured: false }, hubChecksRunning: false, push: { configured: true, devices: 0 }, zonesToken: true, blackouts: [] });
    // Coupure de la surveillance (hub sans Internet) : listée pour Alexandre, jamais comptée en panne.
    await prisma.monitorBlackout.create({ data: { startedAt: new Date(t - 50 * 60_000), endedAt: new Date(t - 20 * 60_000), cause: "hub sans Internet", targets: 1 } });
    expect((await get<MonitorOverview>("/api/monitor")).health.blackouts).toEqual([
      { startedAt: new Date(t - 50 * 60_000).toISOString(), endedAt: new Date(t - 20 * 60_000).toISOString(), durationMs: 30 * 60_000, cause: "hub sans Internet", targets: 1 },
    ]);
    const detail = await get<MonitorTargetDetail>(`/api/monitor/targets/${created.id}?days=7`);
    expect(detail.history).toEqual([expect.objectContaining({ observer: "hub", checks: 1, failures: 0 })]);
    expect(detail.uptime24h).toBe(100);

    const month = `${new Date(t).getFullYear()}-${String(new Date(t).getMonth() + 1).padStart(2, "0")}`;
    const pdf = await hub.app.inject({ method: "GET", url: `/api/monitor/targets/${created.id}/reports/${month}.pdf`, headers: hub.headers });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["content-disposition"]).toBe(`attachment; filename="surveillance-client-exemple.fr-${month}.pdf"`);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await get<MonitorTargetDetail>(`/api/monitor/targets/${created.id}`)).reports).toEqual([expect.objectContaining({ month })]);
    expect((await hub.app.inject({ method: "GET", url: `/api/monitor/targets/${created.id}/reports/2099-01.pdf`, headers: hub.headers })).statusCode).toBe(400);
    expect((await hub.app.inject({ method: "GET", url: `/api/monitor/targets/${created.id}/reports/rapport.pdf`, headers: hub.headers })).statusCode).toBe(404);
  });

  it("acceptation de la référence de contenu", async () => {
    const created = (await send("POST", "/api/monitor/targets", { url: "https://client-exemple.fr/", label: "C" })).json() as MonitorTargetEntry;
    const accepted = (await send("POST", `/api/monitor/targets/${created.id}/content/accept`)).json() as MonitorTargetEntry;
    expect(accepted.content).toMatchObject({ status: "ok" });
    status.set("https://client-exemple.fr/", 500);
    expect((await send("POST", `/api/monitor/targets/${created.id}/content/accept`)).statusCode).toBe(502);
  });
});

describe("santé locale", () => {
  it("/api/health donne l'état minimal de la veille (appel local, sans session)", async () => {
    const res = await hub.app.inject({ method: "GET", url: "/api/health" });
    expect(res.json()).toMatchObject({ ok: true, veille: { configured: false, lastSeenAt: null }, intl: { ok: true, problems: [] } });
  });
});

describe("notifications Web Push", () => {
  const subscription = (endpoint: string) => {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    return { endpoint, expirationTime: null, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
  };

  it("clé publique, abonnement, appareils (avec endpoint), test, 410 retire l'abonnement, retrait", async () => {
    const config = await get<{ publicKey: string | null }>("/api/push/config");
    expect(config.publicKey).toMatch(/^B[A-Za-z0-9_-]{86}$/);
    const sub = await send("POST", "/api/push/subscribe", { subscription: subscription("https://fcm.googleapis.com/fcm/send/telephone"), label: "Téléphone" });
    expect(sub.statusCode).toBe(201);
    await send("POST", "/api/push/subscribe", { subscription: subscription("https://fcm.googleapis.com/fcm/send/expire"), label: "Ancien" });
    const devices = await get<PushDevice[]>("/api/push/devices");
    expect(devices.map((d) => d.endpoint).sort()).toEqual(["https://fcm.googleapis.com/fcm/send/expire", "https://fcm.googleapis.com/fcm/send/telephone"]);
    expect((await send("POST", "/api/push/subscribe", { subscription: { endpoint: "http://non-https" }, label: "x" })).statusCode).toBe(400);
    // Services push connus seulement, en https sur le port par défaut.
    for (const endpoint of ["https://evil.example/push", "https://192.168.1.10/push", "https://fcm.googleapis.com.evil.example/x", "http://fcm.googleapis.com/fcm/send/x", "https://fcm.googleapis.com:8443/x"]) {
      expect((await send("POST", "/api/push/subscribe", { subscription: subscription(endpoint), label: "x" })).statusCode, endpoint).toBe(400);
    }
    for (const endpoint of ["https://updates.push.services.mozilla.com/wpush/v2/a", "https://web.push.apple.com/a", "https://wns2-par02p.notify.windows.com/w/?token=a"]) {
      expect((await send("POST", "/api/push/subscribe", { subscription: subscription(endpoint), label: "autre" })).statusCode, endpoint).toBe(201);
      await prisma.pushSubscription.deleteMany({ where: { endpoint } });
    }

    const test = await send("POST", "/api/push/test");
    expect(test.json()).toEqual({ sent: 1, failed: 0 });
    expect(pushCalls.sort()).toEqual(["https://fcm.googleapis.com/fcm/send/expire", "https://fcm.googleapis.com/fcm/send/telephone"]);
    expect((await get<PushDevice[]>("/api/push/devices")).map((d) => d.label)).toEqual(["Téléphone"]);

    const id = (sub.json() as PushDevice).id;
    expect((await send("DELETE", `/api/push/devices/${id}`)).json()).toEqual({ ok: true });
    expect((await send("DELETE", `/api/push/devices/${id}`)).statusCode).toBe(404);
    const actions = (await prisma.auditEvent.findMany({ where: { action: { startsWith: "push." } } })).map((a) => a.action).sort();
    expect(actions).toEqual([...Array<string>(5).fill("push.subscribe"), "push.test", "push.unsubscribe"]);
  });
});
