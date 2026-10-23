import type { LicenseStatus, LicenseSummary } from "@hub/contract";
import { daysBetween } from "@hub/license-terms";
import type { BadgeTone } from "@/components/ui/Card";
import { foldText, formatDay, plural } from "@/lib/format";

export const STATUS: Record<LicenseStatus, { label: string; tone: BadgeTone }> = {
  active: { label: "Valide", tone: "green" },
  expiring: { label: "Expire bientôt", tone: "amber" },
  expired: { label: "Expirée", tone: "red" },
};

export type StatusFilter = "all" | LicenseStatus;
export const STATUS_FILTERS: readonly StatusFilter[] = ["all", "active", "expiring", "expired"];

/** « Expire ce soir » (dernier jour valable), « Expire dans 12 jours », « Expirée depuis 3 jours ». */
export function remainingText(expire: string, today: string): string {
  const days = daysBetween(today, expire);
  if (days === 0) return "Expire ce soir";
  if (days > 0) return `Expire dans ${plural(days, "jour", "jours")}`;
  return `Expirée depuis ${plural(-days, "jour", "jours")}`;
}

/** Période de validité en toutes lettres. */
export function validityText(l: Pick<LicenseSummary, "emise" | "expire">): string {
  return `Émise le ${formatDay(l.emise)}, valable jusqu'au ${formatDay(l.expire)} inclus`;
}

/** Recherche sans accents ni casse : entreprise, client de l'ERP, notes. */
export function matchesLicense(l: LicenseSummary, q: string): boolean {
  if (!q) return true;
  return [l.entreprise, l.clientName ?? "", l.notes ?? ""].some((v) => foldText(v).includes(q));
}

/** Autres clés du même client de l'ERP, ou de la même entreprise (nom comparé sans accents ni casse). */
export function sameHolder(all: LicenseSummary[], l: Pick<LicenseSummary, "id" | "entreprise" | "erpClientId">): LicenseSummary[] {
  const name = foldText(l.entreprise.trim());
  return all.filter((o) => o.id !== l.id && ((l.erpClientId !== null && o.erpClientId === l.erpClientId) || foldText(o.entreprise.trim()) === name));
}

/** Journal filtré sur les clés de licence (émissions et modifications). */
export const LICENCE_JOURNAL = `/reglages/journal?action=${encodeURIComponent("licence.*")}`;
