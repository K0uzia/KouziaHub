import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { MonitorTarget } from "@prisma/client";
import type { ReportSettings } from "@/contract.js";
import { FakeErpDirectory } from "@/lib/erp/fake.js";
import {
  buildReportView,
  dayMark,
  generateReport,
  monthBounds,
  pdfPageCount,
  renderReportPdf,
  REPORT_COLORS,
  reportContext,
  type ReportContext,
} from "@/lib/monitor/report.js";
import {
  contrastRatio,
  frDuration,
  frenchTypography,
  frPercent,
  frPhone,
  frShortDuration,
  frTime,
  frWebsite,
  incidentSentence,
  reportState,
  speedComparison,
  speedVerdict,
  verdictSentence,
} from "@/lib/monitor/report-text.js";
import { updateReportSettings } from "@/lib/report-settings.js";
import { availability } from "@/lib/monitor/view.js";
import { prisma, resetDb } from "../helpers/db.js";
import { readPdf } from "../helpers/pdf-text.js";

const ch = (...codes: number[]) => String.fromCharCode(...codes);
/** Termes techniques jamais visibles dans le rapport client. */
const FORBIDDEN = /\b(ttfb|lcp|cls|dns|rdap|tls|https?|cname|aaaa|mx|ssl|ms)\b/i;
const FORBIDDEN_A = /(^|[\s(])A([\s,.)]|$)/;
const DASHES = new RegExp(`[${ch(0x2013, 0x2014)}]`);
const NBSP = ch(0xa0);
const NNBSP = ch(0x202f);
const SUP_ER = ch(0x1d49, 0x02b3);

const MIN = 60_000;
const H = 3_600_000;
const DAY = 86_400_000;
/** Heure de Paris en octobre 2026 (heure d'été jusqu'au 25, UTC+2 ; UTC+1 ensuite). */
const paris = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour - (day < 25 ? 2 : 1), minute));

/** Coordonnées fictives, pour les tests et les exemples seulement. */
const EXAMPLE_SETTINGS: ReportSettings = { displayName: "Kouzia", email: "contact@exemple.fr", phone: "0612345678", website: "https://www.exemple.fr" };

beforeEach(async () => {
  await resetDb();
});

describe("règles du rapport", () => {
  it("durées, heures (Paris) et pourcentages en français", () => {
    expect(frDuration(14 * MIN)).toBe("14 minutes");
    expect(frDuration(65 * MIN)).toBe("1 heure et 5 minutes");
    expect(frShortDuration(47 * MIN)).toBe("47 min");
    expect(frShortDuration(81 * MIN)).toBe("1 h 21");
    expect(frShortDuration(2 * H)).toBe("2 h");
    expect(frShortDuration(51 * H)).toBe("2 j 3 h");
    expect(frTime(paris(12, 3, 2))).toBe("3 h 02");
    expect(frPercent(99.996)).toBe("99,99");
    expect(frPercent(100)).toBe("100");
  });

  it("typographie française : exposant, espaces insécables fines, milliers", () => {
    expect(frenchTypography("du 1er au 31 octobre")).toBe(`du 1${SUP_ER} au 31${NBSP}octobre`);
    expect(frenchTypography("le 1er mars, en 1,8 s, 1 h 21 et 47 min")).toBe(`le 1${SUP_ER}${NBSP}mars, en 1,8${NBSP}s, 1${NBSP}h${NBSP}21 et 47${NBSP}min`);
    expect(frenchTypography("2 salons et 3 heureux")).toBe("2 salons et 3 heureux");
    expect(frenchTypography("99,9 % du temps ; vraiment ? oui ! note : ok")).toBe(
      `99,9${NNBSP}% du temps${NNBSP}; vraiment${NNBSP}? oui${NNBSP}! note${NNBSP}: ok`,
    );
    expect(frenchTypography("17 856 vérifications")).toBe(`17${NNBSP}856 vérifications`);
    expect(frenchTypography("le 1er : 100 %", { narrow: false, superscript: false })).toBe(`le 1er${NBSP}: 100${NBSP}%`);
    expect(frenchTypography("le 21er n'existe pas, 1erement non plus")).toBe("le 21er n'existe pas, 1erement non plus");
    expect(frPhone("0612345678")).toBe(["06", "12", "34", "56", "78"].join(NBSP));
    expect(frWebsite("https://www.exemple.fr")).toBe("www.exemple.fr");
  });

  it("mois au fuseau de Paris", () => {
    const { start, end } = monthBounds("2026-10");
    expect(start.toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-31T23:00:00.000Z");
  });

  it("coupures en phrases vraies (vue détaillée du hub)", () => {
    const now = paris(31, 23).getTime();
    expect(incidentSentence({ startedAt: paris(12, 3, 2), endedAt: paris(12, 3, 16), selfRecovered: true }, now)).toBe(
      "Le 12 octobre, le site a été inaccessible 14 minutes, entre 3 h 02 et 3 h 16. Il est revenu tout seul.",
    );
  });

  it("vitesse : seuils officiels et comparaison au mois précédent", () => {
    expect(speedVerdict(2500, 0.1)).toBe("Rapide");
    expect(speedVerdict(2600, 0.05)).toBe("Correct");
    expect(speedVerdict(4100, 0)).toBe("Lent");
    const september = new Date(Date.UTC(2026, 8, 15));
    expect(speedComparison(1800, null, september)).toBe("Première mesure.");
    expect(speedComparison(1500, 2400, september)).toBe("Plus rapide qu'en septembre.");
  });

  it("état du mois : à surveiller, problème réglé, tout va bien", () => {
    const base = { uptime: 99.95, incidents: 0, openIncident: false, certificateProblem: false, certificateDaysLeft: 60, domainDaysLeft: 200, speed: "Rapide" as const };
    expect(reportState(base)).toEqual({ state: "ok", reasons: [] });
    expect(reportState({ ...base, incidents: 2 })).toEqual({ state: "resolved", reasons: [] });
    expect(reportState({ ...base, certificateDaysLeft: 10 }).reasons).toEqual(["certificate_soon"]);
    expect(verdictSentence({ state: "ok", reasons: [], uptime: 99.9, incidents: 0, openSince: null, certificateUntil: null, domainUntil: null })).toBe(
      "Votre site a bien fonctionné ce mois-ci : il était accessible 99,9 % du temps.",
    );
  });
});

/** Équivalent en niveaux de gris (luminance relative conservée, comme une impression noir et blanc). */
function gray(hex: string): string {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const s = y <= 0.0031308 ? 12.92 * y : 1.055 * y ** (1 / 2.4) - 0.055;
  const v = Math.round(s * 255).toString(16).padStart(2, "0");
  return `#${v}${v}${v}`;
}

describe("couleurs à l'impression (calcul WCAG, en couleur et en gris)", () => {
  const C = REPORT_COLORS;
  const states = ["ok", "watch", "resolved"] as const;
  const modes: Array<[string, (h: string) => string]> = [
    ["couleur", (h) => h],
    ["gris", gray],
  ];
  for (const [mode, f] of modes) {
    it(`${mode} : texte 4,5:1 au moins sur chaque fond`, () => {
      for (const bg of [C.paper, C.soft, ...states.map((k) => C[k].tint)]) {
        for (const fg of [C.ink, C.text, C.muted]) expect(contrastRatio(f(fg), f(bg)), `${fg} sur ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${mode} : icône d'état lisible et marques d'état distinctes entre elles`, () => {
      for (const k of states) {
        expect(contrastRatio(f(C[k].glyph), f(C[k].mark)), `pictogramme ${k}`).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(f(C[k].edge), f(C[k].tint)), `contour ${k} sur son fond`).toBeGreaterThanOrEqual(3);
      }
      for (const [a, b] of [["ok", "watch"], ["ok", "resolved"], ["watch", "resolved"]] as const) {
        expect(contrastRatio(f(C[a].mark), f(C[b].mark)), `${a} et ${b}`).toBeGreaterThanOrEqual(2);
      }
      expect(contrastRatio(f(C.bar.ok), f(C.bar.incident)), "barres accessible et coupure").toBeGreaterThanOrEqual(3);
      for (const k of ["ok", "incident", "nodata"] as const) expect(contrastRatio(f(C.bar[k]), f(C.soft)), `barre ${k}`).toBeGreaterThanOrEqual(3);
    });
  }

  it("frise : chaque état a une forme propre, pas seulement une couleur", () => {
    const shape = (s: "ok" | "incident" | "nodata") => {
      const { color: _color, ...rest } = dayMark(s);
      return JSON.stringify(rest);
    };
    expect(new Set([shape("ok"), shape("incident"), shape("nodata")]).size).toBe(3);
    expect(dayMark("incident").marker).toBe(true);
    expect(dayMark("nodata")).toMatchObject({ filled: false });
    expect(dayMark("nodata").heightRatio).toBeLessThan(1);
  });
});

// --- Données fictives : « Boulangerie Exemple », exemple.fr ---

async function fixtureTarget(): Promise<MonitorTarget> {
  return prisma.monitorTarget.create({ data: { url: "https://www.exemple.fr/", hostname: "www.exemple.fr", label: "Boulangerie Exemple", source: "manual" } });
}

async function seedMonth(target: MonitorTarget, incidents: Array<[Date, Date | null]>, options: { certificateUntil?: string; fromDay?: number } = {}) {
  const id = target.id;
  const from = options.fromDay ?? 1;
  const hours = Array.from({ length: (32 - from) * 24 }, (_, i) => new Date(paris(from, 0).getTime() + i * H));
  await prisma.monitorHourly.createMany({
    data: hours.flatMap((hour) => [
      { targetId: id, hour, observer: "hub", checks: 12, failures: 0 },
      { targetId: id, hour, observer: "edge", checks: 12, failures: 0 },
    ]),
  });
  const validTo = options.certificateUntil ?? "2026-12-31T11:00:00.000Z";
  await prisma.monitorCheck.createMany({
    data: [
      ...Array.from({ length: 31 }, (_, d) => ({ targetId: id, kind: "tls", observer: "hub", at: paris(d + 1, 6), ok: true, detail: JSON.stringify({ ok: true, validTo, daysLeft: 70, issuer: "Exemple", error: null }) })),
      ...Array.from({ length: 31 }, (_, d) => ({ targetId: id, kind: "domain", observer: "hub", at: paris(d + 1, 6, 5), ok: true, detail: JSON.stringify({ expiresAt: "2027-03-01T00:00:00.000Z", registrar: null, daysLeft: 130 }) })),
      ...Array.from({ length: 31 }, (_, d) => ({ targetId: id, kind: "dns", observer: "hub", at: paris(d + 1, 6, 10), ok: true, detail: JSON.stringify({ status: "ok" }) })),
      { targetId: id, kind: "speed", observer: "hub", at: paris(9, 4), ok: true, ms: 300, detail: JSON.stringify({ available: true, ttfbMs: 300, lcpMs: 2300, cls: 0.03, bytes: 420_000, requests: 18 }) },
      { targetId: id, kind: "speed", observer: "hub", at: paris(23, 4), ok: true, ms: 280, detail: JSON.stringify({ available: true, ttfbMs: 280, lcpMs: 1800, cls: 0.02, bytes: 410_000, requests: 17 }) },
      { targetId: id, kind: "speed", observer: "hub", at: new Date(paris(25, 4).getTime() - 31 * DAY), ok: true, ms: 300, detail: JSON.stringify({ available: true, lcpMs: 2600, cls: 0.02 }) },
      { targetId: id, kind: "http", observer: "hub", at: paris(from, 0, 1), ok: true, status: 200, ms: 120 },
    ],
  });
  if (incidents.length) {
    await prisma.monitorIncident.createMany({ data: incidents.map(([startedAt, endedAt]) => ({ targetId: id, startedAt, endedAt, cause: "statut 503", observers: "hub,edge" })) });
  }
}

const NOW = paris(31, 23, 30).getTime() + 2 * H;
const THREE: Array<[Date, Date]> = [
  [paris(5, 10), paris(5, 10, 47)],
  [paris(12, 3, 2), paris(12, 3, 16)],
  [paris(20, 23, 50), paris(21, 0, 10)],
];
const CTX: ReportContext = { clientName: "Boulangerie Exemple", settings: EXAMPLE_SETTINGS };

function expectClean(text: string) {
  expect(text).not.toMatch(FORBIDDEN);
  expect(text).not.toMatch(FORBIDDEN_A);
  expect(text).not.toMatch(DASHES);
}

describe("rapport mensuel (PDF)", () => {
  it("mois calme : tout va bien, une page, polices embarquées, aucun terme technique", async () => {
    const target = await fixtureTarget();
    await seedMonth(target, []);
    const view = await buildReportView(target, "2026-10", NOW, CTX);
    expect(view).toMatchObject({ clientName: "Boulangerie Exemple", period: "du 1er au 31 octobre 2026", state: "ok", stateLabel: "Tout va bien", uptime: "100" });
    expect(view.days).toHaveLength(31);
    expect(view.days.every((d) => d === "ok")).toBe(true);
    expect(view.incidentsSummary).toBeNull();
    expect(view.figures).toEqual([
      { value: "17 856", label: "vérifications d'ouverture" },
      { value: "31", label: "contrôles du cadenas" },
      { value: "31", label: "contrôles du nom de domaine" },
      { value: "2", label: "mesures de vitesse" },
    ]);
    const pdf = await renderReportPdf(view);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdfPageCount(pdf)).toBe(1);
    const { text, fonts } = readPdf(pdf);
    expect(fonts.some((f) => /\+Exo2-Bold$/.test(f))).toBe(true);
    expect(fonts.some((f) => /\+Exo2-SemiBold$/.test(f))).toBe(true);
    expect(fonts.some((f) => /\+SourceSans3-Regular$/.test(f))).toBe(true);
    expect(fonts.some((f) => /\+SourceSans3-Semibold$/.test(f))).toBe(true);
    expect(fonts.filter((f) => !f.includes("+"))).toEqual([]);
    expect(text).toContain("Boulangerie Exemple");
    expect(text).toContain("Tout va bien");
    expect(text).toContain(`du 1${SUP_ER} au 31 octobre 2026`);
    expect(text).toContain(`100${NNBSP}%`);
    expect(text).toContain(`17${NNBSP}856`);
    expect(text).toContain("Page 1 sur 1");
    expect(text).not.toContain("Pas de mesure");
    expectClean(text);
  });

  it("mois à 3 coupures : synthèse, tableau, frise qui marque les jours de coupure", async () => {
    const target = await fixtureTarget();
    await seedMonth(target, THREE);
    const view = await buildReportView(target, "2026-10", NOW, CTX);
    expect(view.state).toBe("resolved");
    expect(view.incidentsSummary).toBe("3 coupures ce mois-ci, 1 h 21 au total ; toutes réglées.");
    expect(view.incidentRows).toEqual([
      { date: "5 octobre", hours: "de 10 h 00 à 10 h 47", duration: "47 min", ongoing: false },
      { date: "12 octobre", hours: "de 3 h 02 à 3 h 16", duration: "14 min", ongoing: false },
      { date: "20 octobre au 21 octobre", hours: "de 23 h 50 à 0 h 10", duration: "20 min", ongoing: false },
    ]);
    const incidentDays = view.days.flatMap((d, i) => (d === "incident" ? [i + 1] : []));
    expect(incidentDays).toEqual([5, 12, 20, 21]);
    expect(view.days).toHaveLength(31);
    const pdf = await renderReportPdf(view);
    expect(pdfPageCount(pdf)).toBe(1);
    const { text } = readPdf(pdf);
    expect(text).toContain("Problème réglé");
    expect(text).toContain("Jour avec coupure");
    expect(text).toContain("de 3 h 02 à 3 h 16");
    expectClean(text);
  });

  it("certificat qui expire dans 10 jours : à surveiller, une page", async () => {
    const target = await fixtureTarget();
    await seedMonth(target, [], { certificateUntil: "2026-11-11T11:00:00.000Z" });
    const view = await buildReportView(target, "2026-10", NOW, CTX);
    expect(view.state).toBe("watch");
    expect(view.certificate).toEqual(["Certificat de sécurité (le cadenas) valable jusqu'au 11 novembre 2026.", "Plus que 10 jours : Kouzia s'en occupe."]);
    const pdf = await renderReportPdf(view);
    expect(pdfPageCount(pdf)).toBe(1);
    const { text } = readPdf(pdf);
    expect(text).toContain("À surveiller");
    expect(text).toContain(`Plus que 10 jours${NNBSP}: Kouzia s'en occupe.`);
    expectClean(text);
  });

  it("mois chargé (14 coupures) : les plus courtes résumées, deux pages au plus", async () => {
    const target = await fixtureTarget();
    const many: Array<[Date, Date]> = Array.from({ length: 14 }, (_, i) => [paris(2 + i * 2, 4, 10), paris(2 + i * 2, 4, 12 + i)]);
    await seedMonth(target, many);
    const view = await buildReportView(target, "2026-10", NOW, CTX);
    expect(view.incidentRows).toHaveLength(8);
    expect(view.incidentsRest).toMatch(/^Et 6 coupures plus courtes \(7 min au plus chacune\)/);
    const pdf = await renderReportPdf(view);
    expect(pdfPageCount(pdf)).toBeLessThanOrEqual(2);
    expectClean(readPdf(pdf).text);
  });

  it("coupure en cours : signalée dans le tableau, à surveiller", async () => {
    const target = await fixtureTarget();
    await seedMonth(target, [[paris(31, 22), null]]);
    const view = await buildReportView(target, "2026-10", NOW, CTX);
    expect(view.state).toBe("watch");
    expect(view.incidentsSummary).toBe("1 coupure ce mois-ci, 2 h au total ; une est encore en cours.");
    expect(view.incidentRows).toEqual([{ date: "31 octobre", hours: "depuis 22 h 00", duration: "en cours (2 h)", ongoing: true }]);
    expect(view.days[30]).toBe("incident");
  });

  it("surveillance commencée en cours de mois : jours sans mesure distincts, légende affichée", async () => {
    const target = await fixtureTarget();
    await seedMonth(target, [], { fromDay: 11 });
    const view = await buildReportView(target, "2026-10", NOW, CTX);
    expect(view.days.slice(0, 10).every((d) => d === "nodata")).toBe(true);
    expect(view.days.slice(10).every((d) => d === "ok")).toBe(true);
    const { text } = readPdf(await renderReportPdf(view));
    expect(text).toContain("Pas de mesure");
  });

  it("sans aucune mesure : pas de chiffre inventé, une page", async () => {
    const target = await fixtureTarget();
    const view = await buildReportView(target, "2026-09", NOW);
    expect(view).toMatchObject({ state: "watch", uptime: null, certificate: null, domain: null, speed: null, figures: [], incidentRows: [] });
    expect(view.days.every((d) => d === "nodata")).toBe(true);
    expect(pdfPageCount(await renderReportPdf(view))).toBe(1);
  });

  it("pied de page : coordonnées des réglages, rien d'affiché pour un champ vide", async () => {
    const target = await fixtureTarget();
    await seedMonth(target, []);
    const withSettings = readPdf(await renderReportPdf(await buildReportView(target, "2026-10", NOW, CTX))).text;
    expect(withSettings).toContain("Rapport préparé par Kouzia");
    expect(withSettings).toContain("contact@exemple.fr");
    // Espace insécable et espace partagent le même glyphe : le texte relu montre une espace.
    expect(withSettings).toContain("06 12 34 56 78");
    expect(withSettings).toContain("www.exemple.fr");
    expect(withSettings).toContain(`Généré le 1${SUP_ER} novembre 2026`);

    const bare = await buildReportView(target, "2026-10", NOW, { clientName: "Boulangerie Exemple", settings: { displayName: null, email: null, phone: null, website: null } });
    expect(bare.footer).toEqual({ preparedBy: "Rapport préparé par Kouzia", contact: [] });
    const bareText = readPdf(await renderReportPdf(bare)).text;
    expect(bareText).toContain("Rapport préparé par Kouzia");
    expect(bareText).not.toContain("@");

    const partial = await buildReportView(target, "2026-10", NOW, { settings: { displayName: "Atelier Exemple", email: null, phone: "0123456789", website: null } });
    expect(partial.footer).toEqual({ preparedBy: "Rapport préparé par Atelier Exemple", contact: [["01", "23", "45", "67", "89"].join(NBSP)] });
  });

  it("nom en tête : client de l'ERP lu à la génération, sinon libellé du site, sinon nom d'hôte", async () => {
    const erp = new FakeErpDirectory([{ id: "c1", displayName: "Boulangerie Exemple SARL", clientNumber: "C-001" }] as never);
    await updateReportSettings({ email: "contact@exemple.fr" });
    const site = await prisma.site.create({ data: { slug: "boul", kind: "CLIENT", erpClientId: "c1", pagesProject: "kz-boul", state: "ONLINE" } });
    const clientTarget = await prisma.monitorTarget.create({ data: { siteId: site.id, siteRole: "working", url: "https://boul.kouzia.com/", hostname: "boul.kouzia.com", label: "x", source: "site" } });
    const ctx = await reportContext(erp, clientTarget);
    expect(ctx.clientName).toBe("Boulangerie Exemple SARL");
    expect(ctx.settings?.email).toBe("contact@exemple.fr");
    const perso = await prisma.site.create({ data: { slug: "perso", kind: "PERSO", label: "Mon portfolio", pagesProject: "kz-perso", state: "ONLINE" } });
    const persoTarget = await prisma.monitorTarget.create({ data: { siteId: perso.id, siteRole: "working", url: "https://perso.kouzia.com/", hostname: "perso.kouzia.com", label: "x", source: "site" } });
    expect((await reportContext(erp, persoTarget)).clientName).toBe("Mon portfolio");
    const manual = await prisma.monitorTarget.create({ data: { url: "https://a.exemple.fr/", hostname: "a.exemple.fr", label: "", source: "manual" } });
    expect((await reportContext(erp, manual)).clientName).toBe("a.exemple.fr");
    const gone = await prisma.monitorTarget.create({ data: { url: "https://b.exemple.fr/", hostname: "b.exemple.fr", label: "Libellé", source: "manual", erpClientId: "inconnu" } });
    expect((await reportContext(erp, gone)).clientName).toBe("Libellé");
  });

  it("génération enregistrée et rapport rattaché à la cible", async () => {
    const target = await fixtureTarget();
    await seedMonth(target, []);
    const dataDir = mkdtempSync(join(tmpdir(), "kouzia-hub-report-"));
    const saved = await generateReport(dataDir, target, "2026-10", NOW, CTX);
    expect(readFileSync(join(dataDir, saved.path)).subarray(0, 5).toString()).toBe("%PDF-");
    expect(await prisma.monitorReport.findFirstOrThrow()).toMatchObject({ targetId: target.id, month: "2026-10" });
  });

  it("disponibilité : temps hors coupure sur le temps observé", () => {
    expect(availability([{ startedAt: new Date(10 * H), endedAt: new Date(12 * H) }], 0, 100 * H, 0)).toBe(98);
    expect(availability([], 0, 100 * H, null)).toBeNull();
  });

  // Script de génération des exemples : REPORT_SAMPLES_DIR=<dossier> npx vitest run monitor-report
  it.skipIf(!process.env.REPORT_SAMPLES_DIR)("écrit les trois PDF d'exemple", async () => {
    const dir = process.env.REPORT_SAMPLES_DIR!;
    mkdirSync(dir, { recursive: true });
    const write = async (name: string, incidents: Array<[Date, Date | null]>, options?: { certificateUntil?: string }) => {
      await resetDb();
      const target = await fixtureTarget();
      await seedMonth(target, incidents, options);
      writeFileSync(join(dir, name), await renderReportPdf(await buildReportView(target, "2026-10", NOW, CTX)));
    };
    await write("rapport-mois-calme.pdf", []);
    await write("rapport-3-incidents.pdf", THREE);
    await write("rapport-a-surveiller.pdf", [], { certificateUntil: "2026-11-11T11:00:00.000Z" });
  });
});
