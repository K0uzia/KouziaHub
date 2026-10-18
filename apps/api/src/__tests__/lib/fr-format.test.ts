import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { frDateNumeric, frNumber, parisDayKey, parisMidnight, parisMonthKey, parisOffsetMs, parisParts } from "@/lib/fr-format.js";
import { checkIntl } from "@/lib/intl-check.js";
import { frDay, frDayYear, frMonth, frMonthYear, frTime, incidentSentence } from "@/lib/monitor/report-text.js";

const HOUR = 3_600_000;

describe("heure de Paris sans Intl", () => {
  it("changements d'heure : dernier dimanche de mars et d'octobre à 1 h UTC", () => {
    expect(parisOffsetMs(Date.UTC(2026, 2, 29, 0, 59))).toBe(HOUR);
    expect(parisOffsetMs(Date.UTC(2026, 2, 29, 1, 0))).toBe(2 * HOUR);
    expect(parisOffsetMs(Date.UTC(2026, 9, 25, 0, 59))).toBe(2 * HOUR);
    expect(parisOffsetMs(Date.UTC(2026, 9, 25, 1, 0))).toBe(HOUR);
    expect(parisParts(Date.UTC(2026, 2, 29, 1, 0))).toMatchObject({ day: 29, hour: 3, minute: 0 });
    expect(parisParts(Date.UTC(2026, 9, 25, 0, 30))).toMatchObject({ day: 25, hour: 2, minute: 30 });
    expect(parisParts(Date.UTC(2026, 9, 25, 1, 30))).toMatchObject({ day: 25, hour: 2, minute: 30 });
  });

  it("même heure que la base de fuseaux de Node, chaque heure de 2024 à 2031", () => {
    const intl = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Paris",
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    const wrong: string[] = [];
    for (let at = Date.UTC(2024, 0, 1); at < Date.UTC(2032, 0, 1); at += HOUR) {
      const v = Object.fromEntries(intl.formatToParts(at).map((p) => [p.type, p.value]));
      const p = parisParts(at);
      if (+v.year! !== p.year || +v.month! !== p.month || +v.day! !== p.day || +v.hour! !== p.hour || +v.minute! !== p.minute) {
        wrong.push(new Date(at).toISOString());
      }
    }
    expect(wrong).toEqual([]);
  });

  it("minuit, mois et jour de Paris, passage d'année compris", () => {
    expect(parisMidnight(2026, 9, 1).toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(parisMidnight(2026, 10, 1).toISOString()).toBe("2026-10-31T23:00:00.000Z");
    expect(parisMidnight(2026, 12, 1).toISOString()).toBe("2026-12-31T23:00:00.000Z");
    expect(parisMonthKey(Date.UTC(2026, 9, 31, 23, 30))).toBe("2026-11");
    expect(parisMonthKey(Date.UTC(2026, 11, 31, 23, 30))).toBe("2027-01");
    expect(parisDayKey(Date.UTC(2026, 6, 14, 22, 0))).toBe("2026-07-15");
    expect(frDateNumeric(Date.UTC(2026, 11, 31, 23, 30))).toBe("01/01/2027");
  });

  it("nombres : milliers dès 1 000, virgule décimale", () => {
    expect(frNumber(7)).toBe("7");
    expect(frNumber(1234)).toBe("1 234");
    expect(frNumber(12345.5)).toBe("12 345,5");
    expect(frNumber(-1234567)).toBe("-1 234 567");
    expect(frNumber(1234, " ")).toBe("1 234");
  });
});

/** Ce que fait Node quand seules les données ICU anglaises sont présentes : toute langue retombe sur l'anglais. */
function simulateEnglishOnlyIcu() {
  const RealDTF = Intl.DateTimeFormat;
  const RealNF = Intl.NumberFormat;
  const en = () => "en-US";
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (_l?: unknown, o?: Intl.DateTimeFormatOptions) {
    return new RealDTF(en(), o);
  } as never);
  vi.spyOn(Intl, "NumberFormat").mockImplementation(function (_l?: unknown, o?: Intl.NumberFormatOptions) {
    return new RealNF(en(), o);
  } as never);
  const realNum = Number.prototype.toLocaleString;
  const realDate = Date.prototype.toLocaleDateString;
  vi.spyOn(Number.prototype, "toLocaleString").mockImplementation(function (this: number, _l?: unknown, o?: Intl.NumberFormatOptions) {
    return realNum.call(this, en(), o);
  });
  vi.spyOn(Date.prototype, "toLocaleDateString").mockImplementation(function (this: Date, _l?: unknown, o?: Intl.DateTimeFormatOptions) {
    return realDate.call(this, en(), o);
  });
}

describe("données ICU anglaises seules (Alpine avec icu-data-en)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("la simulation reproduit bien le défaut de l'ERP (« € » avant le montant)", () => {
    simulateEnglishOnlyIcu();
    expect(new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(1234.5)).toBe("€1,234.50");
    expect(new Intl.DateTimeFormat("fr-FR", { month: "long", timeZone: "UTC" }).format(Date.UTC(2026, 9, 15))).toBe("October");
  });

  it("l'auto-contrôle signale l'écart et dit comment le corriger", () => {
    expect(checkIntl()).toEqual([]);
    simulateEnglishOnlyIcu();
    const problems = checkIntl();
    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.join("\n")).toMatch(/langue retenue : en-US/);
    expect(problems.join("\n")).toMatch(/€1,234\.50 au lieu de 1 234,50 €/);
    expect(problems.every((p) => p.includes("icu-data-full"))).toBe(true);
  });

  it("les textes du rapport PDF restent en français, au mot près", () => {
    const at = new Date(Date.UTC(2026, 9, 1, 1, 2));
    const end = new Date(Date.UTC(2026, 9, 1, 1, 16));
    const expected = {
      day: "1er octobre",
      dayYear: "1er octobre 2026",
      time: "3 h 02",
      month: "octobre",
      monthYear: "octobre 2026",
      sentence: "Le 1er octobre, le site a été inaccessible 14 minutes, entre 3 h 02 et 3 h 16. Il est revenu tout seul.",
    };
    const render = () => ({
      day: frDay(at),
      dayYear: frDayYear(at),
      time: frTime(at),
      month: frMonth(at),
      monthYear: frMonthYear(at),
      sentence: incidentSentence({ startedAt: at, endedAt: end, selfRecovered: true }, end.getTime()),
    });
    expect(render()).toEqual(expected);
    simulateEnglishOnlyIcu();
    expect(render()).toEqual(expected);
    expect(frDayYear(new Date(Date.UTC(2026, 7, 15, 10)))).toBe("15 août 2026");
    expect(frTime(new Date(Date.UTC(2026, 0, 15, 22, 5)))).toBe("23 h 05");
  });
});

describe("code serveur", () => {
  it("n'appelle Intl ni toLocale* qu'à l'auto-contrôle (PDF et notifications déterministes)", () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== "__tests__") walk(full);
        } else if (/\.tsx?$/.test(name)) files.push(full);
      }
    };
    walk(src);
    const offenders = files
      .filter((f) => !f.endsWith(`${path.sep}intl-check.ts`))
      .filter((f) => /\bIntl\.|\.toLocale\w*\(/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(src, f));
    expect(offenders).toEqual([]);
  });
});
