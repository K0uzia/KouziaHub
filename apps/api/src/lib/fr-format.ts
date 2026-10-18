// Dates, heures de Paris et nombres en français sans les données ICU de l'hôte : sur Alpine, icu-data-en
// seul fait retomber Intl fr-FR sur l'anglais (cas réel de l'ERP). Ce qui part dans un PDF ou une
// notification passe par ici ; Intl n'est plus lu que par l'auto-contrôle (intl-check.ts).
//
// Heure de Paris : règle européenne en vigueur depuis 1996 (directive 2000/84/CE), UTC+2 du dernier
// dimanche de mars à 1 h UTC au dernier dimanche d'octobre à 1 h UTC, UTC+1 le reste de l'année.

export const FR_MONTHS = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
] as const;

const HOUR_MS = 3_600_000;

/** Dernier dimanche du mois (0 à 11) à 1 h UTC. */
function lastSundayAt1Utc(year: number, monthIndex: number): number {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  return Date.UTC(year, monthIndex, last.getUTCDate() - last.getUTCDay(), 1);
}

/** Décalage de Paris sur UTC (ms) à un instant donné : 1 h en hiver, 2 h en été. */
export function parisOffsetMs(at: number): number {
  const year = new Date(at).getUTCFullYear();
  return at >= lastSundayAt1Utc(year, 2) && at < lastSundayAt1Utc(year, 9) ? 2 * HOUR_MS : HOUR_MS;
}

export type ParisParts = { year: number; month: number; day: number; hour: number; minute: number };

/** Date et heure à Paris (mois de 1 à 12). */
export function parisParts(d: Date | number): ParisParts {
  const at = typeof d === "number" ? d : d.getTime();
  const local = new Date(at + parisOffsetMs(at));
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
  };
}

/** Minuit à Paris pour une date (mois de 0 à 11 et jour, débordements acceptés). */
export function parisMidnight(year: number, monthIndex: number, day = 1): Date {
  const guess = Date.UTC(year, monthIndex, day);
  return new Date(guess - parisOffsetMs(guess - parisOffsetMs(guess)));
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Mois de Paris « 2026-10 ». */
export function parisMonthKey(d: Date | number): string {
  const p = parisParts(d);
  return `${p.year}-${pad2(p.month)}`;
}

/** Jour de Paris « 2026-10-01 » (comparaison de deux instants). */
export function parisDayKey(d: Date | number): string {
  const p = parisParts(d);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** « 31/10/2026 », jour de Paris. */
export function frDateNumeric(d: Date | number): string {
  const p = parisParts(d);
  return `${pad2(p.day)}/${pad2(p.month)}/${p.year}`;
}

/**
 * Nombre à la française : milliers séparés par `separator` (espace simple par défaut, la police du PDF
 * n'a pas l'espace fine), virgule décimale. Groupé dès 1 000, comme Intl fr-FR.
 */
export function frNumber(value: number, separator = " "): string {
  const negative = value < 0;
  const [int, frac] = String(Math.abs(value)).split(".") as [string, string | undefined];
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
  return `${negative ? "-" : ""}${grouped}${frac ? `,${frac}` : ""}`;
}
