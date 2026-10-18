import type { MonitorCheck, MonitorIncident } from "@prisma/client";
import type { MonitorIncidentEntry, MonitorTargetEntry, MonitorVerdict, SiteMonitorBadge } from "@/contract.js";
import type { MonitorService, TargetWithSite } from "@/lib/monitor/service.js";
import { prisma } from "@/lib/prisma.js";

const DAY_MS = 86_400_000;

type Interval = { startedAt: Date; endedAt: Date | null };

/**
 * Disponibilité sur [from, to] au sens de la règle de décision : temps hors incident sur le temps
 * observé (depuis le premier contrôle de la cible). null sans contrôle dans la fenêtre.
 */
export function availability(incidents: Interval[], from: number, to: number, firstCheckAt: number | null): number | null {
  if (firstCheckAt === null) return null;
  const start = Math.max(from, firstCheckAt);
  if (start >= to) return null;
  let down = 0;
  for (const i of incidents) {
    const s = Math.max(start, i.startedAt.getTime());
    const e = Math.min(to, i.endedAt?.getTime() ?? to);
    if (e > s) down += e - s;
  }
  return Math.round((1 - down / (to - start)) * 10_000) / 100;
}

const parse = <T>(c: MonitorCheck | undefined): T | null => {
  if (!c?.detail) return null;
  try {
    return JSON.parse(c.detail) as T;
  } catch {
    return null;
  }
};

const observation = (c: MonitorCheck | undefined) =>
  c ? { at: c.at.toISOString(), ok: c.ok, status: c.status, ms: c.ms, reason: parse<{ reason: string | null }>(c)?.reason ?? null } : null;

/** Dernier contrôle de chaque (cible, sorte, observateur), en deux requêtes pour toutes les cibles. */
async function latestChecks(targetIds: string[]): Promise<Map<string, MonitorCheck>> {
  if (targetIds.length === 0) return new Map();
  const groups = await prisma.monitorCheck.groupBy({ by: ["targetId", "kind", "observer"], where: { targetId: { in: targetIds } }, _max: { at: true } });
  const rows = groups.length
    ? await prisma.monitorCheck.findMany({
        where: { OR: groups.map((g) => ({ targetId: g.targetId, kind: g.kind, observer: g.observer, at: g._max.at! })) },
      })
    : [];
  const map = new Map<string, MonitorCheck>();
  for (const r of rows) map.set(`${r.targetId}|${r.kind}|${r.observer}`, r);
  return map;
}

export const incidentEntry = (i: MonitorIncident, label: string): MonitorIncidentEntry => ({
  id: i.id,
  targetId: i.targetId,
  targetLabel: label,
  startedAt: i.startedAt.toISOString(),
  endedAt: i.endedAt?.toISOString() ?? null,
  durationMs: i.endedAt ? i.endedAt.getTime() - i.startedAt.getTime() : null,
  cause: i.cause,
  basis: i.observers.split(",").filter((o): o is "hub" | "edge" => o === "hub" || o === "edge"),
});

/** Entrées de l'écran Surveillance, en un nombre fixe de requêtes quel que soit le nombre de cibles. */
export async function buildEntries(monitor: MonitorService, targets: TargetWithSite[], clientNames: Map<string, string>): Promise<MonitorTargetEntry[]> {
  const now = monitor.now();
  const ids = targets.map((t) => t.id);
  const [latest, recent, incidents, firsts] = await Promise.all([
    latestChecks(ids),
    monitor.recentChecks(ids, now),
    prisma.monitorIncident.findMany({
      where: { targetId: { in: ids }, OR: [{ endedAt: null }, { endedAt: { gte: new Date(now - 30 * DAY_MS) } }] },
      orderBy: { startedAt: "desc" },
    }),
    ids.length ? prisma.monitorCheck.groupBy({ by: ["targetId"], where: { targetId: { in: ids }, kind: "http" }, _min: { at: true } }) : Promise.resolve([]),
  ]);
  const first = new Map(firsts.map((f) => [f.targetId, f._min.at?.getTime() ?? null]));

  return targets.map((t) => {
    const get = (kind: string, observer = "hub") => latest.get(`${t.id}|${kind}|${observer}`);
    const own = incidents.filter((i) => i.targetId === t.id);
    const open = own.find((i) => !i.endedAt);
    const decision = monitor.decideFor(recent.get(t.id), now);
    const tls = parse<{ ok: boolean; validTo: string | null; daysLeft: number | null; issuer: string | null; error: string | null }>(get("tls"));
    const domain = parse<{ expiresAt: string | null; daysLeft: number | null; registrar: string | null }>(get("domain"));
    const dns = parse<{ status: "ok" | "drift" | "no_reference" | "error"; drift?: string[]; detail?: string }>(get("dns"));
    const content = parse<{ status: "ok" | "changed" | "no_reference" | "error" }>(get("content"));
    const speed = parse<{ available?: boolean; ttfbMs: number | null; lcpMs: number | null; cls: number | null; bytes: number | null; requests: number | null }>(get("speed"));
    return {
      id: t.id,
      siteId: t.siteId,
      siteSlug: t.site?.slug ?? null,
      label: t.label,
      url: t.url,
      hostname: t.hostname,
      source: t.source === "cloudflare" || t.source === "manual" ? t.source : "site",
      erpClientId: t.erpClientId,
      clientName: t.erpClientId ? (clientNames.get(t.erpClientId) ?? null) : null,
      enabled: t.enabled,
      keyword: t.keyword,
      verdict: t.enabled ? decision.verdict : "unknown",
      basis: decision.basis,
      lastHub: observation(get("http", "hub")),
      lastEdge: observation(get("http", "edge")),
      uptime24h: availability(own, now - DAY_MS, now, first.get(t.id) ?? null),
      uptime30d: availability(own, now - 30 * DAY_MS, now, first.get(t.id) ?? null),
      certificate:
        tls && tls.validTo && tls.daysLeft !== null
          ? { validTo: tls.validTo, daysLeft: tls.daysLeft, issuer: tls.issuer, ok: tls.ok, error: tls.error }
          : null,
      domainExpiry: get("domain")
        ? { expiresAt: domain?.expiresAt ?? null, daysLeft: domain?.daysLeft ?? null, registrar: domain?.registrar ?? null, checkedAt: get("domain")!.at.toISOString() }
        : null,
      dns: get("dns")
        ? { status: dns?.status ?? "error", checkedAt: get("dns")!.at.toISOString(), detail: dns?.drift?.length ? dns.drift.join(", ") : (dns?.detail ?? null) }
        : null,
      content: get("content") ? { status: content?.status ?? "error", checkedAt: get("content")!.at.toISOString() } : null,
      speed:
        get("speed") && speed?.available !== false
          ? { measuredAt: get("speed")!.at.toISOString(), ttfbMs: speed?.ttfbMs ?? null, lcpMs: speed?.lcpMs ?? null, cls: speed?.cls ?? null, bytes: speed?.bytes ?? null, requests: speed?.requests ?? null }
          : null,
      openIncident: open ? { id: open.id, startedAt: open.startedAt.toISOString(), basis: incidentEntry(open, t.label).basis } : null,
      createdAt: t.createdAt.toISOString(),
    };
  });
}

const RANK: Record<MonitorVerdict, number> = { unknown: 0, up: 1, local_only: 2, edge_only: 3, down: 4 };

/** Badges du catalogue : une série fixe de requêtes pour tous les sites (pas de N+1). */
export async function siteBadges(monitor: MonitorService, siteIds: string[]): Promise<Map<string, SiteMonitorBadge>> {
  const out = new Map<string, SiteMonitorBadge>();
  if (siteIds.length === 0) return out;
  const targets = (await prisma.monitorTarget.findMany({
    where: { siteId: { in: siteIds }, enabled: true },
    include: { site: { select: { id: true, slug: true, state: true } } },
  })) as TargetWithSite[];
  const watched = targets.filter((t) => !(t.siteRole === "working" && t.site && t.site.state !== "ONLINE"));
  if (watched.length === 0) return out;
  const now = monitor.now();
  const ids = watched.map((t) => t.id);
  const [recent, incidents, firsts, expiries] = await Promise.all([
    monitor.recentChecks(ids, now),
    prisma.monitorIncident.findMany({ where: { targetId: { in: ids }, OR: [{ endedAt: null }, { endedAt: { gte: new Date(now - 30 * DAY_MS) } }] } }),
    prisma.monitorCheck.groupBy({ by: ["targetId"], where: { targetId: { in: ids }, kind: "http" }, _min: { at: true } }),
    latestChecks(ids),
  ]);
  const first = new Map(firsts.map((f) => [f.targetId, f._min.at?.getTime() ?? null]));
  const daysLeftOf = (targetId: string): number | null => {
    const values = ["tls", "domain"]
      .map((kind) => parse<{ daysLeft: number | null }>(expiries.get(`${targetId}|${kind}|hub`))?.daysLeft)
      .filter((v): v is number => typeof v === "number");
    return values.length ? Math.min(...values) : null;
  };
  for (const t of watched) {
    const siteId = t.siteId!;
    const own = incidents.filter((i) => i.targetId === t.id);
    const verdict = monitor.decideFor(recent.get(t.id), now).verdict;
    const uptime = availability(own, now - 30 * DAY_MS, now, first.get(t.id) ?? null);
    const open = own.filter((i) => !i.endedAt).map((i) => i.startedAt.getTime());
    const prev = out.get(siteId);
    const oldestOpen = Math.min(...open, prev?.openIncidentSince ? Date.parse(prev.openIncidentSince) : Infinity);
    out.set(siteId, {
      verdict: !prev || RANK[verdict] > RANK[prev.verdict] ? verdict : prev.verdict,
      watched: (prev?.watched ?? 0) + 1,
      uptime30d: uptime === null ? (prev?.uptime30d ?? null) : prev?.uptime30d == null ? uptime : Math.min(prev.uptime30d, uptime),
      openIncidentSince: Number.isFinite(oldestOpen) ? new Date(oldestOpen).toISOString() : null,
      expiresInDays: ((a, b) => (a === null ? b : b === null ? a : Math.min(a, b)))(prev?.expiresInDays ?? null, daysLeftOf(t.id)),
    });
  }
  return out;
}
