import { inflateSync } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { MonitorTarget } from "@prisma/client";
import { buildReportView, generateReport, monthBounds, pdfPageCount, renderReportPdf, REPORT_COLORS } from "@/lib/monitor/report.js";
import {
  contrastRatio,
  frDuration,
  frPercent,
  frTime,
  incidentSentence,
  reportState,
  speedComparison,
  speedVerdict,
  verdictSentence,
} from "@/lib/monitor/report-text.js";
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
  return text.replace(/\s+/g, " ");
}

/** Termes techniques jamais visibles dans le rapport client. */
const FORBIDDEN = /\b(ttfb|lcp|cls|dns|rdap|tls|https?|cname|aaaa|mx|ssl|ms)\b/i;
const FORBIDDEN_A = /(^|[\s(])A([\s,.)]|$)/;

const MIN = 60_000;
const H = 3_600_000;
const DAY = 86_400_000;
/** Heure de Paris en octobre 2026 (heure d'été jusqu'au 25, UTC+2 ; UTC+1 ensuite). */
const paris = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour - (day < 25 ? 2 : 1), minute));

beforeEach(async () => {
  await resetDb();
});

describe("règles du rapport", () => {
  it("durées, heures (Paris) et pourcentages en français", () => {
    expect(frDuration(14 * MIN)).toBe("14 minutes");
    expect(frDuration(MIN)).toBe("1 minute");
    expect(frDuration(65 * MIN)).toBe("1 heure et 5 minutes");
    expect(frDuration(2 * H)).toBe("2 heures");
    expect(frDuration(51 * H)).toBe("2 jours et 3 heures");
    expect(frTime(paris(12, 3, 2))).toBe("3 h 02");
    expect(frPercent(99.996)).toBe("99,99");
    expect(frPercent(100)).toBe("100");
    expect(frPercent(99.9)).toBe("99,9");
  });

  it("mois au fuseau de Paris", () => {
    const { start, end } = monthBounds("2026-10");
    expect(start.toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-31T23:00:00.000Z");
  });

  it("coupures en phrases vraies", () => {
    const now = paris(31, 23).getTime();
    expect(incidentSentence({ startedAt: paris(12, 3, 2), endedAt: paris(12, 3, 16), selfRecovered: true }, now)).toBe(
      "Le 12 octobre, le site a été inaccessible 14 minutes, entre 3 h 02 et 3 h 16. Il est revenu tout seul.",
    );
    expect(incidentSentence({ startedAt: paris(12, 23, 50), endedAt: paris(13, 0, 10), selfRecovered: false }, now)).toBe(
      "Du 12 octobre à 23 h 50 au 13 octobre à 0 h 10, le site a été inaccessible 20 minutes. Il a été rétabli.",
    );
    expect(incidentSentence({ startedAt: paris(1, 9), endedAt: paris(1, 9, 5), selfRecovered: null }, now)).toContain("1er octobre");
    expect(incidentSentence({ startedAt: paris(1, 9), endedAt: paris(1, 9, 5), selfRecovered: null }, now)).toContain("Il est de nouveau accessible.");
    expect(incidentSentence({ startedAt: paris(31, 22), endedAt: null, selfRecovered: null }, now)).toMatch(/^Depuis le 31 octobre à 22 h 00, le site est inaccessible/);
  });

  it("vitesse : seuils officiels et comparaison au mois précédent", () => {
    expect(speedVerdict(2500, 0.1)).toBe("Rapide");
    expect(speedVerdict(2600, 0.05)).toBe("Correct");
    expect(speedVerdict(1800, 0.2)).toBe("Correct");
    expect(speedVerdict(4100, 0)).toBe("Lent");
    expect(speedVerdict(1000, 0.3)).toBe("Lent");
    const september = new Date(Date.UTC(2026, 8, 15));
    expect(speedComparison(1800, null, september)).toBe("Première mesure.");
    expect(speedComparison(1800, 1900, september)).toBe("Comme le mois dernier.");
    expect(speedComparison(1500, 2400, september)).toBe("Plus rapide qu'en septembre.");
    expect(speedComparison(3000, 2000, september)).toBe("Plus lent qu'en septembre.");
  });

  it("état du mois : à surveiller, problème réglé, tout va bien", () => {
    const base = { uptime: 99.95, incidents: 0, openIncident: false, certificateProblem: false, certificateDaysLeft: 60, domainDaysLeft: 200, speed: "Rapide" as const };
    expect(reportState(base)).toEqual({ state: "ok", reasons: [] });
    expect(reportState({ ...base, incidents: 2 })).toEqual({ state: "resolved", reasons: [] });
    expect(reportState({ ...base, incidents: 1, openIncident: true }).reasons).toEqual(["open_incident"]);
    expect(reportState({ ...base, uptime: 98.5, incidents: 3 }).state).toBe("watch");
    expect(reportState({ ...base, uptime: null }).reasons).toEqual(["no_data"]);
    expect(reportState({ ...base, certificateDaysLeft: 10 }).reasons).toEqual(["certificate_soon"]);
    expect(reportState({ ...base, certificateProblem: true }).reasons).toEqual(["certificate_problem"]);
    expect(reportState({ ...base, domainDaysLeft: 20 }).reasons).toEqual(["domain_soon"]);
    expect(reportState({ ...base, speed: "Lent" }).reasons).toEqual(["slow"]);
    expect(verdictSentence({ state: "ok", reasons: [], uptime: 99.9, incidents: 0, openSince: null, certificateUntil: null, domainUntil: null })).toBe(
      "Votre site a bien fonctionné ce mois-ci : il était accessible 99,9 % du temps.",
    );
  });

  it("contraste à l'impression : texte 4,5:1 au moins, icônes 3:1 au moins (calcul WCAG)", () => {
    const C = REPORT_COLORS;
    for (const bg of [C.paper, C.tile, C.ok.tint, C.watch.tint, C.resolved.tint]) {
      expect(contrastRatio(C.ink, bg), `encre sur ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(C.muted, bg), `texte secondaire sur ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const k of ["ok", "watch", "resolved"] as const) {
      expect(contrastRatio(C[k].mark, C[k].tint), k).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(C.paper, C[k].mark), `trait blanc sur ${k}`).toBeGreaterThanOrEqual(3);
    }
  });
});

// --- Données fictives : « Boulangerie Exemple », exemple.fr ---

async function fixtureTarget(): Promise<MonitorTarget> {
  return prisma.monitorTarget.create({ data: { url: "https://www.exemple.fr/", hostname: "www.exemple.fr", label: "Boulangerie Exemple", source: "manual" } });
}

async function seedMonth(target: MonitorTarget, incidents: Array<[Date, Date | null]>) {
  const id = target.id;
  const hours = Array.from({ length: 31 * 24 }, (_, i) => new Date(paris(1, 0).getTime() + i * H));
  await prisma.monitorHourly.createMany({
    data: hours.flatMap((hour) => [
      { targetId: id, hour, observer: "hub", checks: 12, failures: 0 },
      { targetId: id, hour, observer: "edge", checks: 12, failures: 0 },
    ]),
  });
  await prisma.monitorCheck.createMany({
    data: [
      ...Array.from({ length: 31 }, (_, d) => ({ targetId: id, kind: "tls", observer: "hub", at: paris(d + 1, 6), ok: true, detail: JSON.stringify({ ok: true, validTo: "2026-12-31T11:00:00.000Z", daysLeft: 70, issuer: "Exemple", error: null }) })),
      ...Array.from({ length: 31 }, (_, d) => ({ targetId: id, kind: "domain", observer: "hub", at: paris(d + 1, 6, 5), ok: true, detail: JSON.stringify({ expiresAt: "2027-03-01T00:00:00.000Z", registrar: null, daysLeft: 130 }) })),
      ...Array.from({ length: 31 }, (_, d) => ({ targetId: id, kind: "dns", observer: "hub", at: paris(d + 1, 6, 10), ok: true, detail: JSON.stringify({ status: "ok" }) })),
      { targetId: id, kind: "speed", observer: "hub", at: paris(9, 4), ok: true, ms: 300, detail: JSON.stringify({ available: true, ttfbMs: 300, lcpMs: 2300, cls: 0.03, bytes: 420_000, requests: 18 }) },
      { targetId: id, kind: "speed", observer: "hub", at: paris(23, 4), ok: true, ms: 280, detail: JSON.stringify({ available: true, ttfbMs: 280, lcpMs: 1800, cls: 0.02, bytes: 410_000, requests: 17 }) },
      { targetId: id, kind: "speed", observer: "hub", at: new Date(paris(25, 4).getTime() - 31 * DAY), ok: true, ms: 300, detail: JSON.stringify({ available: true, lcpMs: 2600, cls: 0.02 }) },
      { targetId: id, kind: "http", observer: "hub", at: paris(1, 0, 1), ok: true, status: 200, ms: 120 },
    ],
  });
  if (incidents.length) {
    await prisma.monitorIncident.createMany({ data: incidents.map(([startedAt, endedAt]) => ({ targetId: id, startedAt, endedAt, cause: "statut 503", observers: "hub,edge" })) });
  }
}

const NOW = paris(31, 23, 30).getTime() + 2 * H;

describe("rapport mensuel (PDF)", () => {
  it("mois calme : tout va bien, une page, aucun terme technique", async () => {
    const target = await fixtureTarget();
    await seedMonth(target, []);
    const view = await buildReportView(target, "2026-10", NOW);
    expect(view).toMatchObject({ state: "ok", stateLabel: "Tout va bien", uptime: "100", availabilityNote: "Aucune coupure ce mois-ci." });
    expect(view.verdict).toBe("Votre site a bien fonctionné ce mois-ci : il était accessible 100 % du temps.");
    expect(view.speed).toEqual({ verdict: "Rapide", seconds: "1,8", comparison: "Plus rapide qu'en septembre.", stability: expect.stringMatching(/bonne/) });
    expect(view.certificate![0]).toBe("Certificat de sécurité (le cadenas) valable jusqu'au 31 décembre 2026.");
    expect(view.domain).toEqual(["Nom de domaine réservé jusqu'au 1er mars 2027.", "Réglages techniques de l'adresse inchangés."]);
    expect(view.kouzia).toEqual([
      "17 856 vérifications que le site s'ouvre, de jour comme de nuit.",
      "31 vérifications du cadenas de sécurité.",
      "31 vérifications du nom de domaine.",
      "31 vérifications des réglages de l'adresse.",
      "2 mesures de la vitesse d'ouverture.",
    ]);
    const pdf = await renderReportPdf(view);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdfPageCount(pdf)).toBe(1);
    const text = pdfText(pdf);
    expect(text).toContain("Tout va bien");
    expect(text).toContain("100 %");
    expect(text).not.toMatch(FORBIDDEN);
    expect(text).not.toMatch(FORBIDDEN_A);
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  it("mois avec 3 coupures réglées : problème réglé, phrases datées, une page", async () => {
    const target = await fixtureTarget();
    await seedMonth(target, [
      [paris(5, 10), paris(5, 10, 47)],
      [paris(12, 3, 2), paris(12, 3, 16)],
      [paris(20, 23, 50), paris(21, 0, 10)],
    ]);
    const view = await buildReportView(target, "2026-10", NOW);
    expect(view.state).toBe("resolved");
    expect(view.verdict).toMatch(/^Votre site a été inaccessible 3 fois ce mois-ci, puis il est revenu : il était accessible 99,8\d? % du temps\.$/);
    expect(view.availabilityNote).toBe("3 coupures, 1 heure et 21 minutes au total.");
    expect(view.incidents.lines[1]).toBe("Le 12 octobre, le site a été inaccessible 14 minutes, entre 3 h 02 et 3 h 16. Il est de nouveau accessible.");
    expect(view.kouzia).toContain("3 coupures détectées et suivies.");
    const pdf = await renderReportPdf(view);
    expect(pdfPageCount(pdf)).toBe(1);
    const text = pdfText(pdf);
    expect(text).toContain("Problème réglé");
    expect(text).not.toMatch(FORBIDDEN);
    expect(text).not.toMatch(FORBIDDEN_A);
  });

  it("« revenu tout seul » seulement si aucune action n'a été faite sur le site pendant la coupure", async () => {
    const site = await prisma.site.create({ data: { slug: "exemple", kind: "PERSO", label: "Exemple", pagesProject: "kz-exemple", state: "ONLINE" } });
    const target = await prisma.monitorTarget.create({ data: { siteId: site.id, siteRole: "final", url: "https://www.exemple.fr/", hostname: "www.exemple.fr", label: "x", source: "site" } });
    await seedMonth(target, [
      [paris(5, 10), paris(5, 10, 30)],
      [paris(12, 3, 2), paris(12, 3, 16)],
    ]);
    await prisma.auditEvent.create({ data: { siteId: site.id, siteSlug: "exemple", action: "version.republish", result: "ok", at: paris(5, 10, 20) } });
    const view = await buildReportView(target, "2026-10", NOW);
    expect(view.incidents.lines[0]).toMatch(/Il a été rétabli\.$/);
    expect(view.incidents.lines[1]).toMatch(/Il est revenu tout seul\.$/);
  });

  it("mois chargé : coupures courtes résumées, deux pages au plus", async () => {
    const target = await fixtureTarget();
    const many: Array<[Date, Date]> = Array.from({ length: 14 }, (_, i) => [paris(2 + i * 2, 4, 10), paris(2 + i * 2, 4, 12 + i)]);
    await seedMonth(target, many);
    const view = await buildReportView(target, "2026-10", NOW);
    expect(view.incidents.lines).toHaveLength(5);
    expect(view.incidents.summary).toMatch(/^Et 9 coupures plus courtes/);
    const pdf = await renderReportPdf(view);
    expect(pdfPageCount(pdf)).toBeLessThanOrEqual(2);
    expect(pdfText(pdf)).not.toMatch(FORBIDDEN);
  });

  it("coupure en cours et échéance proche : à surveiller", async () => {
    const target = await fixtureTarget();
    await seedMonth(target, [[paris(31, 22), null]]);
    const view = await buildReportView(target, "2026-10", NOW);
    expect(view.state).toBe("watch");
    expect(view.verdict).toBe("Votre site est inaccessible depuis le 31 octobre à 22 h 00. Kouzia suit la situation.");
  });

  it("sans aucune mesure : pas de tuile vide ni de chiffre inventé", async () => {
    const target = await fixtureTarget();
    const view = await buildReportView(target, "2026-09", NOW);
    expect(view).toMatchObject({ state: "watch", uptime: null, certificate: null, domain: null, speed: null, kouzia: [] });
    expect(pdfPageCount(await renderReportPdf(view))).toBe(1);
  });

  it("génération enregistrée et rapport rattaché à la cible", async () => {
    const target = await fixtureTarget();
    await seedMonth(target, []);
    const dataDir = mkdtempSync(join(tmpdir(), "kouzia-hub-report-"));
    const saved = await generateReport(dataDir, target, "2026-10", NOW);
    expect(readFileSync(join(dataDir, saved.path)).subarray(0, 5).toString()).toBe("%PDF-");
    expect(await prisma.monitorReport.findFirstOrThrow()).toMatchObject({ targetId: target.id, month: "2026-10" });
  });

  it("disponibilité : temps hors coupure sur le temps observé", () => {
    expect(availability([{ startedAt: new Date(10 * H), endedAt: new Date(12 * H) }], 0, 100 * H, 0)).toBe(98);
    expect(availability([], 0, 100 * H, null)).toBeNull();
  });

  // Exemples à regarder : REPORT_SAMPLES_DIR=<dossier> npx vitest run monitor-report
  it.skipIf(!process.env.REPORT_SAMPLES_DIR)("écrit les deux PDF d'exemple", async () => {
    const dir = process.env.REPORT_SAMPLES_DIR!;
    mkdirSync(dir, { recursive: true });
    const calm = await fixtureTarget();
    await seedMonth(calm, []);
    writeFileSync(join(dir, "rapport-mois-calme.pdf"), await renderReportPdf(await buildReportView(calm, "2026-10", NOW)));
    await resetDb();
    const busy = await fixtureTarget();
    await seedMonth(busy, [
      [paris(5, 10), paris(5, 10, 47)],
      [paris(12, 3, 2), paris(12, 3, 16)],
      [paris(20, 23, 50), paris(21, 0, 10)],
    ]);
    writeFileSync(join(dir, "rapport-3-incidents.pdf"), await renderReportPdf(await buildReportView(busy, "2026-10", NOW)));
  });
});
