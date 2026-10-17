import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditEntry, OrphanReport, SystemStatus } from "@/contract.js";
import { prisma, resetDb } from "../helpers/db.js";
import { buildTestHub, createPersoSite, type TestHub } from "../helpers/hub.js";

let hub: TestHub;

beforeEach(async () => {
  await resetDb();
  hub = await buildTestHub();
});
afterEach(async () => {
  await hub.app.close();
});

describe("contrôle des orphelins", () => {
  it("détecte CNAME orphelin, projet kz- sans site et site sans projet ; supprime seulement le CNAME orphelin", async () => {
    const id = await createPersoSite(hub, "alpha");
    hub.cf.seedDnsRecord({ type: "CNAME", name: "fantome.kouzia.com", content: "kz-fantome.pages.dev", proxied: true, comment: "kouzia-hub:disparu" });
    hub.cf.seedDnsRecord({ type: "A", name: "www.kouzia.com", content: "192.0.2.1", proxied: true, comment: null });
    hub.cf.seedProject("kz-perdu");
    hub.cf.seedProject("autre-chose");

    const check = await hub.app.inject({ method: "POST", url: "/api/orphans/check", headers: hub.headers });
    const report = check.json() as OrphanReport;
    expect(report.mode).toBe("fake");
    expect(report.error).toBeNull();
    expect(report.findings).toEqual([
      { type: "dns", name: "fantome.kouzia.com", detail: expect.any(String), deletable: true },
      { type: "project", name: "kz-perdu", detail: expect.any(String), deletable: false },
    ]);
    expect((await hub.app.inject({ method: "GET", url: "/api/orphans", headers: hub.headers })).json()).toEqual(report);

    const catalog = (await hub.app.inject({ method: "GET", url: "/api/sites", headers: hub.headers })).json();
    expect(catalog.notices.map((n: { code: string }) => n.code)).toContain("orphans");

    const refused = await hub.app.inject({ method: "POST", url: "/api/orphans/dns/delete", headers: hub.headers, payload: { name: "alpha.kouzia.com" } });
    expect(refused.statusCode).toBe(409);
    const external = await hub.app.inject({ method: "POST", url: "/api/orphans/dns/delete", headers: hub.headers, payload: { name: "www.kouzia.com" } });
    expect(external.statusCode).toBe(409);

    const del = await hub.app.inject({ method: "POST", url: "/api/orphans/dns/delete", headers: hub.headers, payload: { name: "fantome.kouzia.com" } });
    expect(del.statusCode).toBe(200);
    expect((del.json() as OrphanReport).findings.map((f) => f.name)).toEqual(["kz-perdu"]);
    expect(hub.cf.snapshot().dns.map((r) => r.name).sort()).toEqual(["alpha.kouzia.com", "www.kouzia.com"]);
    expect(await prisma.auditEvent.findFirst({ where: { action: "orphan.delete" } })).toMatchObject({ result: "ok", detail: "CNAME fantome.kouzia.com" });

    // Projet supprimé hors hub : le site en ligne est signalé, son CNAME devient orphelin (cible absente).
    const projectName = (await prisma.site.findUniqueOrThrow({ where: { id } })).pagesProject;
    hub.cf.dropProject(projectName);
    const after = (await hub.app.inject({ method: "POST", url: "/api/orphans/check", headers: hub.headers })).json() as OrphanReport;
    expect(after.findings.map((f) => `${f.type}:${f.name}`).sort()).toEqual(["dns:alpha.kouzia.com", "project:kz-perdu", "site:alpha.kouzia.com"]);
  });

  it("Cloudflare en erreur : résultat enregistré avec le message", async () => {
    hub.cf.failNext("listHubDnsRecords");
    const report = (await hub.app.inject({ method: "POST", url: "/api/orphans/check", headers: hub.headers })).json() as OrphanReport;
    expect(report.error).toMatch(/^Contrôle impossible/);
  });
});

describe("système, clients et journal", () => {
  it("état du système", async () => {
    hub.cf.seedProject("x");
    const status = (await hub.app.inject({ method: "GET", url: "/api/system", headers: hub.headers })).json() as SystemStatus;
    expect(status).toEqual({
      cloudflare: { mode: "fake", projectsUsed: 1, projectsLimit: 100 },
      erp: { mode: "fake", reachable: true },
      thumbnails: { capture: false },
      sitesDomain: "kouzia.com",
    });
  });

  it("clients de l'ERP filtrés", async () => {
    const res = await hub.app.inject({ method: "GET", url: `/api/erp/clients?q=${encodeURIComponent("FLEURISTE")}`, headers: hub.headers });
    expect(res.json()).toEqual({ available: true, clients: [expect.objectContaining({ id: "demo-09" })] });
  });

  it("journal des actions, filtrable par site, sans secret", async () => {
    const id = await createPersoSite(hub, "alpha");
    await createPersoSite(hub, "bravo");
    const all = (await hub.app.inject({ method: "GET", url: "/api/audit", headers: hub.headers })).json() as AuditEntry[];
    expect(all.map((e) => e.action)).toEqual(expect.arrayContaining(["auth.login", "site.create"]));
    const one = (await hub.app.inject({ method: "GET", url: `/api/audit?siteId=${id}&limit=5`, headers: hub.headers })).json() as AuditEntry[];
    expect(one.length).toBeGreaterThan(0);
    expect(one.every((e) => e.siteSlug === "alpha")).toBe(true);
    const bad = await hub.app.inject({ method: "GET", url: "/api/audit?limit=9999", headers: hub.headers });
    expect(bad.statusCode).toBe(400);
  });
});
