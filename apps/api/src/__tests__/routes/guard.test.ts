import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "@/app.js";
import { FakeCloudflare } from "@/lib/cloudflare/fake.js";
import { createServices } from "@/lib/services.js";
import { resetDb } from "../helpers/db.js";
import { createAdmin, loginCookie } from "../helpers/auth.js";

// Chaque route métier du contrat : 401 sans session, avant toute lecture du corps.
const ROUTES: Array<[string, string]> = [
  ["GET", "/api/sites"],
  ["GET", "/api/sites/slug-check?slug=alpha"],
  ["POST", "/api/sites"],
  ["GET", "/api/sites/s1"],
  ["PATCH", "/api/sites/s1"],
  ["POST", "/api/sites/s1/enable"],
  ["POST", "/api/sites/s1/disable"],
  ["POST", "/api/sites/s1/operations/o1/retry"],
  ["DELETE", "/api/sites/s1"],
  ["GET", "/api/sites/s1/files"],
  ["GET", "/api/sites/s1/files/raw?path=index.html"],
  ["GET", "/api/sites/s1/uploads"],
  ["POST", "/api/sites/s1/uploads"],
  ["GET", "/api/sites/s1/uploads/0123456789abcdef01234567"],
  ["PUT", "/api/sites/s1/uploads/0123456789abcdef01234567/chunks/0"],
  ["POST", "/api/sites/s1/uploads/0123456789abcdef01234567/complete"],
  ["DELETE", "/api/sites/s1/uploads/0123456789abcdef01234567"],
  ["POST", "/api/sites/s1/files/delete"],
  ["POST", "/api/sites/s1/files/move"],
  ["POST", "/api/sites/s1/publish"],
  ["GET", "/api/sites/s1/versions"],
  ["POST", "/api/sites/s1/versions/v1/publish"],
  ["POST", "/api/sites/s1/versions/v1/restore"],
  ["GET", "/api/sites/s1/thumbnail"],
  ["POST", "/api/sites/s1/thumbnail"],
  ["POST", "/api/sites/s1/thumbnail/capture"],
  ["GET", "/api/erp/clients?q=a"],
  ["GET", "/api/system"],
  ["GET", "/api/orphans"],
  ["POST", "/api/orphans/check"],
  ["POST", "/api/orphans/dns/delete"],
  ["GET", "/api/audit"],
  ["GET", "/api/sites/s1/server-config/preview"],
  ["POST", "/api/sites/s1/server-config/regenerate"],
  ["GET", "/api/monitor"],
  ["POST", "/api/monitor/targets"],
  ["GET", "/api/monitor/targets/t1?days=30"],
  ["PATCH", "/api/monitor/targets/t1"],
  ["DELETE", "/api/monitor/targets/t1"],
  ["POST", "/api/monitor/targets/t1/check"],
  ["POST", "/api/monitor/targets/t1/dns/accept"],
  ["POST", "/api/monitor/targets/t1/content/accept"],
  ["GET", "/api/monitor/targets/t1/reports/2026-10.pdf"],
  ["GET", "/api/monitor/zones"],
  ["POST", "/api/monitor/zones/client.fr/watch"],
  ["GET", "/api/sites/s1/monitor"],
  ["GET", "/api/push/config"],
  ["GET", "/api/push/devices"],
  ["POST", "/api/push/subscribe"],
  ["DELETE", "/api/push/devices/d1"],
  ["POST", "/api/push/test"],
  ["POST", "/api/sites/s1/files/purge"],
  ["POST", "/api/sites/s1/cache/purge"],
  ["GET", "/api/storage"],
  ["POST", "/api/storage/purge"],
  ["GET", "/api/sites/s1/export/summary"],
  ["GET", "/api/sites/s1/export?target=hostinger"],
  ["GET", "/api/settings/reports"],
  ["PATCH", "/api/settings/reports"],
];

describe("routes protégées", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    await resetDb();
    app = await buildApp({ silent: true, serveStatic: false, accessVerifier: null, services: createServices({ cloudflare: new FakeCloudflare(), chromiumPath: null }) });
  });
  afterAll(async () => {
    await app.close();
  });

  it.each(ROUTES)("%s %s : 401 sans session", async (method, url) => {
    const res = await app.inject({
      method: method as "GET",
      url,
      headers: { origin: "http://localhost:5174", "content-type": "application/json" },
      payload: method === "GET" ? undefined : "{}",
    });
    expect(res.statusCode).toBe(401);
  });

  it("401 aussi avec un cookie de session inconnu", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sites", headers: { cookie: "kz_hub_session=inconnu" } });
    expect(res.statusCode).toBe(401);
  });
});

// Audit du 27/10/2026 (motif de la P0 de l'ERP) : chaque garde juge la route reconnue, jamais le préfixe de
// l'adresse brute. Chemin encodé (%61 pour « a »), %2e%2e, double barre, majuscules.
const DISGUISED = ["/%61pi/sites", "/api/%73ites", "/api/x/%2e%2e/sites", "/api/sites/%2e%2e/system", "//api/sites", "/api//sites", "/API/sites", "/Api/system"];

describe("chemins déguisés", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    await resetDb();
    app = await buildApp({ silent: true, serveStatic: false, accessVerifier: null, services: createServices({ cloudflare: new FakeCloudflare(), chromiumPath: null }) });
  });
  afterAll(async () => {
    await app.close();
  });

  it.each(DISGUISED)("GET %s : jamais servi sans session", async (url) => {
    expect([401, 404]).toContain((await app.inject({ method: "GET", url })).statusCode);
  });

  it("mutation d'une autre origine par un chemin encodé : 403", async () => {
    const res = await app.inject({ method: "POST", url: "/%61pi/sites", headers: { origin: "https://evil.example", "content-type": "application/json" }, payload: "{}" });
    expect(res.statusCode).toBe(403);
  });

  it("chemin encodé avec session : contrôle des paramètres et no-store comme par /api/", async () => {
    await createAdmin();
    const cookie = await loginCookie(app);
    const bad = await app.inject({ method: "GET", url: "/%61pi/sites/a%3Cb", headers: { cookie } });
    expect(bad.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/%61pi/sites?x=%01", headers: { cookie } })).statusCode).toBe(400);
    const list = await app.inject({ method: "GET", url: "/%61pi/sites", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.headers["cache-control"]).toBe("no-store");
  });

  it("Cloudflare Access : seule /api/health est ouverte, encodée ou non ; le reste exige le jeton", async () => {
    const guarded = await buildApp({ silent: true, serveStatic: false, accessVerifier: { verify: async () => false } as never, services: createServices({ cloudflare: new FakeCloudflare(), chromiumPath: null }) });
    try {
      expect((await guarded.inject({ method: "GET", url: "/api/%68ealth" })).statusCode).toBe(200);
      for (const url of ["/%61pi/sites", "/api/health/%2e%2e/sites", "/api/sites?/api/health"]) {
        expect((await guarded.inject({ method: "GET", url })).statusCode).toBe(404);
      }
    } finally {
      await guarded.close();
    }
  });

  it("par le tunnel, un autre hôte reste en 404 quel que soit le chemin", async () => {
    process.env.TRUST_PROXY = "loopback";
    process.env.HUB_PUBLIC_ORIGIN = "https://hub.kouzia.com";
    const tunnel = await buildApp({ silent: true, serveStatic: false, accessVerifier: null, services: createServices({ cloudflare: new FakeCloudflare(), chromiumPath: null }) });
    try {
      for (const url of ["/%61pi/health", "/api/%68ealth", "//api/health", "/API/health"]) {
        const res = await tunnel.inject({ method: "GET", url, remoteAddress: "127.0.0.1", headers: { host: "autre.kouzia.com", "cf-connecting-ip": "203.0.113.9" } });
        expect(res.statusCode).toBe(404);
      }
    } finally {
      await tunnel.close();
      delete process.env.TRUST_PROXY;
      delete process.env.HUB_PUBLIC_ORIGIN;
    }
  });
});
