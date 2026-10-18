import { inflateSync } from "node:zlib";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildReportData, durationLabel, generateReport, renderReportPdf } from "@/lib/monitor/report.js";
import { availability } from "@/lib/monitor/view.js";
import { prisma, resetDb } from "../helpers/db.js";

/** Texte d'un PDF : flux décompressés, chaînes hexadécimales des opérateurs de texte décodées. */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  let text = "";
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    let content: string;
    try {
      content = inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1");
    } catch {
      continue;
    }
    for (const block of content.match(/\[[^\]]*\]\s*TJ|<[0-9a-fA-F]+>\s*Tj/g) ?? []) {
      for (const hex of block.match(/<([0-9a-fA-F]+)>/g) ?? []) text += Buffer.from(hex.slice(1, -1), "hex").toString("latin1");
      text += " ";
    }
  }
  return text;
}

const H = 3_600_000;
const oct = (day: number, hour = 0) => new Date(2026, 9, day, hour);

beforeEach(async () => {
  await resetDb();
});

describe("disponibilité", () => {
  it("temps hors incident sur le temps observé, null sans contrôle", () => {
    const from = 0;
    const to = 100 * H;
    expect(availability([{ startedAt: new Date(10 * H), endedAt: new Date(12 * H) }], from, to, 0)).toBe(98);
    expect(availability([{ startedAt: new Date(90 * H), endedAt: null }], from, to, 50 * H)).toBe(80);
    expect(availability([], from, to, null)).toBeNull();
    expect(durationLabel(2 * H + 5 * 60_000)).toBe("2 h 5 min");
    expect(durationLabel(50 * H)).toBe("2 j 2 h");
  });
});

describe("rapport mensuel", () => {
  it("chiffres du mois et PDF généré, non vide, avec les valeurs attendues", async () => {
    const target = await prisma.monitorTarget.create({ data: { url: "https://client-exemple.fr/", hostname: "client-exemple.fr", label: "client-exemple.fr", source: "manual" } });
    const id = target.id;
    await prisma.monitorCheck.createMany({
      data: [
        { targetId: id, kind: "http", observer: "hub", at: oct(1), ok: true, status: 200, ms: 120 },
        { targetId: id, kind: "tls", observer: "hub", at: oct(20), ok: true, detail: JSON.stringify({ ok: true, validTo: "2026-12-31T12:00:00.000Z", daysLeft: 70, issuer: "Let's Encrypt", error: null }) },
        { targetId: id, kind: "domain", observer: "hub", at: oct(20), ok: true, detail: JSON.stringify({ expiresAt: "2027-03-01T00:00:00.000Z", registrar: "Registrar Exemple", daysLeft: 130 }) },
        { targetId: id, kind: "speed", observer: "hub", at: oct(7), ok: true, ms: 300, detail: JSON.stringify({ available: true, ttfbMs: 300, lcpMs: 2100, cls: 0.02, bytes: 420 * 1024, requests: 18 }) },
        { targetId: id, kind: "speed", observer: "hub", at: oct(14), ok: true, ms: 280, detail: JSON.stringify({ available: true, ttfbMs: 280, lcpMs: 1800, cls: 0.01, bytes: 410 * 1024, requests: 17 }) },
        { targetId: id, kind: "dns", observer: "hub", at: oct(10), ok: true, detail: JSON.stringify({ status: "ok" }) },
        { targetId: id, kind: "dns", observer: "hub", at: oct(11), ok: false, detail: JSON.stringify({ status: "drift", drift: ["A"] }) },
        { targetId: id, kind: "content", observer: "hub", at: oct(12), ok: false, detail: JSON.stringify({ status: "changed" }) },
      ],
    });
    await prisma.monitorHourly.createMany({
      data: [
        { targetId: id, hour: oct(1, 0), observer: "hub", checks: 100, failures: 2 },
        { targetId: id, hour: oct(1, 0), observer: "edge", checks: 50, failures: 0 },
      ],
    });
    await prisma.monitorIncident.create({ data: { targetId: id, startedAt: oct(5, 10), endedAt: oct(5, 12), cause: "statut 503", observers: "hub,edge" } });

    const data = await buildReportData(target, "2026-10", oct(31, 23).getTime() + H);
    // 2 h de panne sur 31 jours observés.
    expect(data.uptime).toBe(99.73);
    expect(data).toMatchObject({
      hubRate: 98,
      edgeRate: 100,
      incidents: [{ duration: "2 h", cause: "statut 503" }],
      certificate: { issuer: "Let's Encrypt", ok: true },
      domainExpiry: { expiresAt: "2027-03-01T00:00:00.000Z", registrar: "Registrar Exemple" },
      speed: { available: true, last: { lcpMs: 1800, requests: 17 }, previousLcpMs: 2100 },
      dns: { checks: 2, drifts: ["11/10/2026 : A"] },
      content: { checks: 1, changes: ["12/10/2026"] },
    });

    const pdf = await renderReportPdf(data);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(2000);
    const text = pdfText(pdf);
    for (const expected of ["99,73", "client-exemple.fr", "statut 503", "1 800 ms", "Registrar Exemple"]) {
      expect(text.replace(/\s+/g, " ").replace(/ | /g, " "), expected).toContain(expected);
    }

    const dataDir = mkdtempSync(join(tmpdir(), "kouzia-hub-report-"));
    const saved = await generateReport(dataDir, target, "2026-10", oct(31).getTime());
    expect(readFileSync(join(dataDir, saved.path)).subarray(0, 5).toString()).toBe("%PDF-");
    expect(await prisma.monitorReport.findFirstOrThrow()).toMatchObject({ targetId: id, month: "2026-10", path: saved.path });
  });

  it("mois sans contrôle : disponibilité non mesurée, sans erreur", async () => {
    const target = await prisma.monitorTarget.create({ data: { url: "https://b.fr/", hostname: "b.fr", label: "b.fr", source: "manual" } });
    const data = await buildReportData(target, "2026-09", Date.now());
    expect(data).toMatchObject({ uptime: null, incidents: [], certificate: null, domainExpiry: null, speed: { last: null } });
    expect((await renderReportPdf(data)).subarray(0, 5).toString()).toBe("%PDF-");
  });
});
