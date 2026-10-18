import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "@/app.js";
import { FakeCloudflare } from "@/lib/cloudflare/fake.js";
import { createServices } from "@/lib/services.js";
import { resetDb } from "../helpers/db.js";

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
  ["POST", "/api/sites/s1/files"],
  ["POST", "/api/sites/s1/files/delete"],
  ["POST", "/api/sites/s1/files/move"],
  ["POST", "/api/sites/s1/zip"],
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
