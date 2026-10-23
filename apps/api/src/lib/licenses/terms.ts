// Règles des clés Tracebay sans dépendance (docs/licences-logiciels.md, sections 3 et 6) : partagées avec
// l'interface (@hub/license-terms), qui calcule l'aperçu avec les mêmes dates que le serveur.

export const ENTREPRISE_MAX = 120;
/** Durées proposées (mois), défaut 12 ; une date libre reste possible dans les bornes. */
export const LICENSE_MONTHS = [1, 3, 6, 12, 24, 36] as const;
export const DEFAULT_MONTHS = 12;
/** Bientôt expirée : 30 jours ou moins, jour d'expiration inclus (JOURS_AVERTISSEMENT de Tracebay). */
export const EXPIRING_DAYS = 30;
/** Après `expire`, Tracebay permet encore l'écriture pendant 15 jours (JOURS_GRACE_APRES_EXPIRATION), clé invalide. */
export const GRACE_DAYS = 15;
/** Expiration au plus tard dix ans après l'émission. */
const MAX_MONTHS = 120;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type LicenseStatus = "active" | "expiring" | "expired";

/** Nom signé : espaces de bord retirés, NFC, 1 à 120 caractères, sans caractère de contrôle (Cc). */
export function normalizeEntreprise(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const value = raw.trim().normalize("NFC");
  if (!value) return { ok: false, reason: "Le nom de l'entreprise est obligatoire." };
  if ([...value].length > ENTREPRISE_MAX) return { ok: false, reason: `Nom de l'entreprise trop long (${ENTREPRISE_MAX} caractères au plus).` };
  if (/\p{Cc}/u.test(value)) return { ok: false, reason: "Le nom de l'entreprise contient un caractère de contrôle." };
  return { ok: true, value };
}

export function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Même quantième N mois plus tard, sinon le dernier jour du mois d'arrivée (31 janvier + 1 mois = 28 ou 29 février). */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const index = m - 1 + months;
  const year = y + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** Jours de a à b (dates de calendrier). */
export function daysBetween(a: string, b: string): number {
  return Math.round((utcOf(b) - utcOf(a)) / 86_400_000);
}

/** Jour de calendrier décalé de n jours. */
export function addDays(day: string, n: number): string {
  return new Date(utcOf(day) + n * 86_400_000).toISOString().slice(0, 10);
}

function utcOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

/**
 * Date d'expiration demandée : N mois (1 à 36) ou une date libre, entre le jour d'émission et dix ans après.
 * Exactement un des deux.
 */
export function expiryOf(emise: string, input: { months?: number; expire?: string }): { ok: true; value: string } | { ok: false; reason: string } {
  if ((input.months === undefined) === (input.expire === undefined)) return { ok: false, reason: "Durée en mois ou date de fin : l'une des deux, pas les deux." };
  if (input.months !== undefined) {
    if (!Number.isInteger(input.months) || input.months < 1 || input.months > 36) return { ok: false, reason: "Durée de 1 à 36 mois." };
    return { ok: true, value: addMonths(emise, input.months) };
  }
  if (!isDay(input.expire)) return { ok: false, reason: "Date de fin attendue au format AAAA-MM-JJ." };
  if (input.expire < emise) return { ok: false, reason: "La date de fin ne peut pas précéder le jour d'émission." };
  if (input.expire > addMonths(emise, MAX_MONTHS)) return { ok: false, reason: "Date de fin au plus tard dix ans après l'émission." };
  return { ok: true, value: input.expire };
}

/** État au jour de Paris : expirée le lendemain de « expire », bientôt expirée s'il reste 30 jours ou moins (jour inclus). */
export function licenseStatus(expire: string, today: string): LicenseStatus {
  if (today > expire) return "expired";
  return daysBetween(today, expire) + 1 <= EXPIRING_DAYS ? "expiring" : "active";
}
