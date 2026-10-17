/**
 * Intl (fr-FR) sépare les milliers par une espace fine insécable (U+202F) que la police de
 * l'interface affiche sans largeur : remplacée par l'espace insécable (U+00A0).
 */
export function frenchSpaces(text: string): string {
  return text.replace(/[  ]/g, " ");
}

export function formatDecimal(value: number, maxFractionDigits = 2): string {
  return frenchSpaces(new Intl.NumberFormat("fr-FR", { maximumFractionDigits: maxFractionDigits }).format(value));
}

/** Taille de fichier : 820 o, 12 Ko, 1,5 Mo. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  if (bytes < 1024 * 1024 * 1024) return `${formatDecimal(bytes / (1024 * 1024), 1)} Mo`;
  return `${formatDecimal(bytes / (1024 * 1024 * 1024), 1)} Go`;
}

const dateFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** 17 oct. 2026 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return frenchSpaces(dateFmt.format(new Date(iso)));
}

/** 17 oct. 2026, 14:05 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return frenchSpaces(dateTimeFmt.format(new Date(iso)));
}

/** « à l'instant », « il y a 5 min », « il y a 2 h », « hier », sinon la date. */
export function formatAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const min = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  if (min < 24 * 60) return `il y a ${Math.floor(min / 60)} h`;
  if (min < 48 * 60) return "hier";
  return formatDate(iso);
}

/** « 1 fichier », « 3 fichiers ». */
export function plural(count: number, one: string, many: string): string {
  return `${formatDecimal(count, 0)} ${count > 1 ? many : one}`;
}
