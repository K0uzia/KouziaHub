import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faCircleCheck,
  faCircleQuestion,
  faCloud,
  faHouseSignal,
  faTriangleExclamation,
} from "@fortawesome/free-solid-svg-icons";
import type { MonitorHistoryPoint, MonitorTargetEntry, MonitorVerdict } from "@hub/contract";
import type { BadgeTone } from "@/components/ui/Card";
import { formatDecimal, frenchSpaces } from "@/lib/format";

export type VerdictLook = { label: string; short: string; icon: IconDefinition; tone: BadgeTone };

/** Verdict de surveillance en texte + icône (règle de décision du cadrage 10.1). */
export const VERDICT: Record<MonitorVerdict, VerdictLook> = {
  up: { label: "En ligne", short: "Surveillé : en ligne", icon: faCircleCheck, tone: "green" },
  down: { label: "En panne", short: "En panne", icon: faTriangleExclamation, tone: "red" },
  local_only: { label: "Problème local", short: "Problème local", icon: faHouseSignal, tone: "amber" },
  edge_only: { label: "Vu par Cloudflare seulement", short: "Vu par Cloudflare seul", icon: faCloud, tone: "amber" },
  unknown: { label: "Pas encore contrôlé", short: "Pas encore contrôlé", icon: faCircleQuestion, tone: "neutral" },
};

const timeFmt = new Intl.DateTimeFormat("fr-FR", { hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });

/** « 14 h 32 » aujourd'hui, sinon « 17 oct., 14 h 32 ». */
export function formatSince(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = timeFmt.format(d).replace(":", " h ");
  const sameDay = d.toDateString() === now.toDateString();
  return frenchSpaces(sameDay ? time : `${dayFmt.format(d)}, ${time}`);
}

/** Durée lisible : « 45 s », « 12 min », « 2 h 14 min », « 3 j 4 h ». */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} j ${h % 24} h` : `${d} j`;
}

/** Disponibilité « 99,95 % », ou null. */
export function formatUptime(value: number | null | undefined): string | null {
  if (value == null) return null;
  return `${formatDecimal(value, value >= 99.9 && value < 100 ? 2 : 1)} %`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "inconnu";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${formatDecimal(ms / 1000, 2)} s`;
}

/** Point de vue d'un verdict : « vu par le hub et par Cloudflare », « vu par Cloudflare seul »… */
export function basisLabel(basis: Array<"hub" | "edge">): string {
  const hub = basis.includes("hub");
  const edge = basis.includes("edge");
  if (hub && edge) return "vu par le hub et par Cloudflare";
  if (edge) return "vu par Cloudflare seul";
  if (hub) return "vu par le hub seul";
  return "aucun point de contrôle n'a encore répondu";
}

/** Plus petit nombre de jours restants (certificat ou domaine), pour l'avertissement d'échéance. */
export function soonestExpiry(t: Pick<MonitorTargetEntry, "certificate" | "domainExpiry">): number | null {
  const days = [t.certificate?.daysLeft, t.domainExpiry?.daysLeft].filter((d): d is number => typeof d === "number");
  return days.length ? Math.min(...days) : null;
}

/** Seuil d'avertissement des échéances (cadrage 10.4 : 30, 14 et 7 jours). */
export const EXPIRY_WARN_DAYS = 30;

/** Ordre de la liste : pannes d'abord, puis problèmes, puis le reste. */
const RANK: Record<MonitorVerdict, number> = { down: 0, local_only: 1, edge_only: 1, unknown: 2, up: 3 };
export function byGravity(a: MonitorTargetEntry, b: MonitorTargetEntry): number {
  const ra = a.enabled ? RANK[a.verdict] : 4;
  const rb = b.enabled ? RANK[b.verdict] : 4;
  return ra - rb || a.label.localeCompare(b.label, "fr");
}

export type DayStat = { day: string; checks: number; failures: number; rate: number | null };

/** Contrôles regroupés par jour (les deux points de contrôle ensemble), sur les `days` derniers jours. */
export function dailyStats(history: MonitorHistoryPoint[], days = 30, now = new Date()): DayStat[] {
  const byDay = new Map<string, { checks: number; failures: number }>();
  for (const p of history) {
    const key = p.hour.slice(0, 10);
    const cur = byDay.get(key) ?? { checks: 0, failures: 0 };
    cur.checks += p.checks;
    cur.failures += p.failures;
    byDay.set(key, cur);
  }
  const out: DayStat[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    const v = byDay.get(key);
    out.push({ day: key, checks: v?.checks ?? 0, failures: v?.failures ?? 0, rate: v && v.checks ? (100 * (v.checks - v.failures)) / v.checks : null });
  }
  return out;
}

export function formatDay(day: string): string {
  return frenchSpaces(dayFmt.format(new Date(`${day}T12:00:00Z`)));
}
