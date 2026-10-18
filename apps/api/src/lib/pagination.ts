import { z } from "zod";
import type { Page } from "@/contract.js";
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

/** Jour du calendrier (AAAA-MM-JJ), heure locale du hub. */
export const dayParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => {
    const [y, m, day] = d.split("-").map(Number) as [number, number, number];
    const date = new Date(y, m - 1, day);
    return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === day;
  }, "Date invalide.");

/** Période « du … au … » incluse ; 400 si le début suit la fin. */
export function dayRange(from?: string, to?: string): { gte?: Date; lt?: Date } | undefined {
  if (!from && !to) return undefined;
  const gte = from ? new Date(`${from}T00:00:00`) : undefined;
  const end = to ? new Date(`${to}T00:00:00`) : undefined;
  if (end) end.setDate(end.getDate() + 1);
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
