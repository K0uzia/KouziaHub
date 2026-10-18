import { z } from "zod";
import type { Page } from "@/contract.js";
import { parisMidnight } from "@/lib/fr-format.js";
import { HttpError } from "@/lib/http.js";

// Listes longues paginées côté serveur, par numéro de page (page, pageSize) : l'interface affiche
// « page X sur Y » et un total, et les volumes du hub (un seul utilisateur, SQLite) restent petits.
// Tri stable du plus récent au plus ancien, départagé par l'identifiant.

export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 100;

/** page ≥ 1 (au-delà de la dernière : liste vide, total juste) ; pageSize 1 à 100, plafonné à 100 au-delà. */
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .default(PAGE_SIZE_DEFAULT)
    .transform((n) => Math.min(n, PAGE_SIZE_MAX)),
});

/** Jour du calendrier (AAAA-MM-JJ), à l'heure de Paris (le CT est en UTC). */
export const dayParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => {
    const [y, m, day] = d.split("-").map(Number) as [number, number, number];
    const date = new Date(Date.UTC(y, m - 1, day));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === day;
  }, "Date invalide.");

/** Minuit à Paris d'un jour AAAA-MM-JJ, décalé de `plus` jours (23 ou 25 h aux changements d'heure). */
function parisDayStart(day: string, plus = 0): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return parisMidnight(y, m - 1, d + plus);
}

/** Période « du … au … » incluse, jours de Paris ; 400 si le début suit la fin. */
export function dayRange(from?: string, to?: string): { gte?: Date; lt?: Date } | undefined {
  if (!from && !to) return undefined;
  const gte = from ? parisDayStart(from) : undefined;
  const end = to ? parisDayStart(to, 1) : undefined;
  if (gte && end && gte >= end) throw new HttpError(400, "La date de début doit précéder la date de fin.");
  return { ...(gte ? { gte } : {}), ...(end ? { lt: end } : {}) };
}

export function skipTake(q: { page: number; pageSize: number }): { skip: number; take: number } {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}

export function pageOf<T>(items: T[], total: number, q: { page: number; pageSize: number }): Page<T> {
  return { items, total, page: q.page, pageSize: q.pageSize };
}

/** Message 400 commun des paramètres de liste. */
export function badListQuery(): HttpError {
  return new HttpError(400, "Paramètres de liste invalides.");
}
