import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditEntry, MonitorIncidentEntry, Page, VersionEntry } from "@/contract.js";
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

const DAY = 86_400_000;
/** Midi heure locale, il y a `n` jours : à l'abri des bords de journée pour les filtres de période. */
function daysAgo(n: number): Date {
  const d = new Date(Date.now() - n * DAY);
  d.setHours(12, 0, 0, 0);
  return d;
}
function day(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function get<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await hub.app.inject({ method: "GET", url, headers: hub.headers });
  return { status: res.statusCode, body: res.json() as T };
}

/** 47 actions : 30 « site.update » réussies sur 30 jours, 12 en échec, 5 « push.test » réussies. */
async function seedAudit(): Promise<void> {
  await prisma.auditEvent.deleteMany();
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => ({ action: "site.update", result: "ok", at: daysAgo(i) })),
    ...Array.from({ length: 12 }, (_, i) => ({ action: "site.update", result: "error", detail: `échec ${i}`, at: daysAgo(i * 2) })),
    ...Array.from({ length: 5 }, (_, i) => ({ action: "push.test", result: "ok", at: daysAgo(40 + i) })),
  ];
  await prisma.auditEvent.createMany({ data: rows });
}

describe("journal paginé (GET /api/audit)", () => {
  it("total juste, pages pleines, dernière page partielle, tri du plus récent au plus ancien", async () => {
    await seedAudit();
    const p1 = await get<Page<AuditEntry>>("/api/audit");
    expect(p1.status).toBe(200);
    expect(p1.body).toMatchObject({ total: 47, page: 1, pageSize: 20 });
    expect(p1.body.items).toHaveLength(20);
    const p2 = await get<Page<AuditEntry>>("/api/audit?page=2");
    const p3 = await get<Page<AuditEntry>>("/api/audit?page=3");
    expect(p2.body.items).toHaveLength(20);
    expect(p3.body.items).toHaveLength(7);
    const all = [...p1.body.items, ...p2.body.items, ...p3.body.items];
    expect(new Set(all.map((e) => e.id)).size).toBe(47);
    const dates = all.map((e) => e.at);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it("page au-delà de la dernière : liste vide, total gardé", async () => {
    await seedAudit();
    const out = await get<Page<AuditEntry>>("/api/audit?page=9");
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ items: [], total: 47, page: 9, pageSize: 20 });
  });

  it("pageSize plafonné à 100, paramètres invalides refusés", async () => {
    await seedAudit();
    const big = await get<Page<AuditEntry>>("/api/audit?pageSize=500");
    expect(big.body.pageSize).toBe(100);
    expect(big.body.items).toHaveLength(47);
    for (const q of ["page=0", "page=-1", "page=abc", "pageSize=0", "result=peut-etre", "from=2026-02-31", "from=hier", "action=SITE%20UPDATE"]) {
      expect((await get(`/api/audit?${q}`)).status, q).toBe(400);
    }
    const reversed = await get(`/api/audit?from=${day(daysAgo(1))}&to=${day(daysAgo(5))}`);
    expect(reversed.status).toBe(400);
  });

  it("filtres combinés : action, résultat et période", async () => {
    await seedAudit();
    const errors = await get<Page<AuditEntry>>("/api/audit?result=error&pageSize=100");
    expect(errors.body.total).toBe(12);
    expect(errors.body.items.every((e) => e.result === "error")).toBe(true);

    const okUpdates = await get<Page<AuditEntry>>("/api/audit?action=site.update&result=ok");
    expect(okUpdates.body.total).toBe(30);
    expect(okUpdates.body.items).toHaveLength(20);

    // Période incluse : de J-9 à J-0 → 10 réussites et 5 échecs (J-0, J-2, J-4, J-6, J-8).
    const period = await get<Page<AuditEntry>>(`/api/audit?action=site.update&from=${day(daysAgo(9))}&to=${day(daysAgo(0))}&pageSize=100`);
    expect(period.body.total).toBe(15);
    const periodErrors = await get<Page<AuditEntry>>(`/api/audit?action=site.update&result=error&from=${day(daysAgo(9))}&to=${day(daysAgo(0))}`);
    expect(periodErrors.body.total).toBe(5);

    const push = await get<Page<AuditEntry>>(`/api/audit?action=push.test&to=${day(daysAgo(42))}`);
    expect(push.body.total).toBe(3);
    const none = await get<Page<AuditEntry>>("/api/audit?action=site.delete");
    expect(none.body).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });
});

describe("incidents paginés (GET /api/monitor/incidents)", () => {
  it("par adresse, par site, en cours ou terminés, période, pages", async () => {
    const siteId = await createPersoSite(hub, "alpha");
    const a = await prisma.monitorTarget.create({ data: { url: "https://a.exemple.fr/", hostname: "a.exemple.fr", label: "A", source: "manual" } });
    const b = await prisma.monitorTarget.create({ data: { siteId, siteRole: "final", url: "https://b.exemple.fr/", hostname: "b.exemple.fr", label: "B", source: "site" } });
    await prisma.monitorIncident.createMany({
      data: [
        ...Array.from({ length: 23 }, (_, i) => ({ targetId: a.id, startedAt: daysAgo(i + 1), endedAt: new Date(daysAgo(i + 1).getTime() + 600_000), cause: "statut 503", observers: "hub,edge" })),
        { targetId: a.id, startedAt: daysAgo(0), endedAt: null, cause: "délai dépassé", observers: "hub" },
        ...Array.from({ length: 4 }, (_, i) => ({ targetId: b.id, startedAt: daysAgo(i + 2), endedAt: daysAgo(i + 1), observers: "edge" })),
      ],
    });

    const all = await get<Page<MonitorIncidentEntry>>("/api/monitor/incidents");
    expect(all.body).toMatchObject({ total: 28, page: 1, pageSize: 20 });
    expect((await get<Page<MonitorIncidentEntry>>("/api/monitor/incidents?page=2")).body.items).toHaveLength(8);

    const ofA = await get<Page<MonitorIncidentEntry>>(`/api/monitor/incidents?targetId=${a.id}&page=2`);
    expect(ofA.body.total).toBe(24);
    expect(ofA.body.items).toHaveLength(4);
    expect(ofA.body.items.every((i) => i.targetLabel === "A")).toBe(true);

    const ofSite = await get<Page<MonitorIncidentEntry>>(`/api/monitor/incidents?siteId=${siteId}`);
    expect(ofSite.body.total).toBe(4);

    const open = await get<Page<MonitorIncidentEntry>>("/api/monitor/incidents?state=open");
    expect(open.body.total).toBe(1);
    expect(open.body.items[0]).toMatchObject({ endedAt: null, cause: "délai dépassé" });

    const closedRecent = await get<Page<MonitorIncidentEntry>>(`/api/monitor/incidents?targetId=${a.id}&state=closed&from=${day(daysAgo(5))}`);
    expect(closedRecent.body.total).toBe(5);

    expect((await get(`/api/monitor/incidents?state=fini`)).status).toBe(400);
    expect((await get(`/api/monitor/incidents?pageSize=1000`)).status).toBe(200);
  });
});

describe("versions paginées (GET /api/sites/:id/versions)", () => {
  it("la plus récente d'abord, numéro d'origine des republications même hors page", async () => {
    const siteId = await createPersoSite(hub, "alpha");
    const first = await prisma.version.findFirstOrThrow({ where: { siteId } });
    await prisma.version.createMany({
      data: Array.from({ length: 24 }, (_, i) => ({
        siteId,
        number: i + 2,
        source: i === 23 ? "republish" : "files",
        sourceVersionId: i === 23 ? first.id : null,
        status: "PUBLISHED",
        fileCount: 1,
        totalBytes: 10,
      })),
    });
    const p1 = await get<Page<VersionEntry>>(`/api/sites/${siteId}/versions`);
    expect(p1.body.total).toBe(25);
    expect(p1.body.items[0]).toMatchObject({ number: 25, source: "republish", sourceVersionNumber: first.number });
    const p2 = await get<Page<VersionEntry>>(`/api/sites/${siteId}/versions?page=2`);
    expect(p2.body.items.map((v) => v.number)).toEqual([5, 4, 3, 2, 1]);
    expect((await get(`/api/sites/${siteId}/versions?page=0`)).status).toBe(400);
  });
});
