// Surveillance côté hub (cadrage section 10) : cibles, contrôles, comparaison avec le Worker,
// incidents, alertes non urgentes (et urgentes si le Worker manque), historique, purge.
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { MonitorCheck, MonitorIncident, MonitorTarget, Site } from "@prisma/client";
import { audit } from "@/lib/audit.js";
import { frDateNumeric, parisParts } from "@/lib/fr-format.js";
import {
  decide,
  GROUP_ALERT_THRESHOLD,
  INCIDENT_REMINDER_MS,
  isAllowedPushEndpoint,
  OBSERVER_STALE_MS,
  type Decision,
  type EdgeObservation,
  type HttpObservation,
  type MonitorTargetSpec,
  type Observer,
  type ObserverState,
  type StateResponse,
} from "@/lib/monitor/core.js";
import {
  CONNECTIVITY_PROBES,
  contentHash,
  defaultResolver,
  dnsDrift,
  dnsSnapshot,
  guardedFetch,
  httpCheck,
  internetReachable,
  makeTlsConnector,
  RdapClient,
  systemLookup,
  daysUntil,
  registrableDomain,
  tlsCheck,
  type DnsResolver,
  type DnsSnapshot,
  type HostLookup,
  type TlsConnector,
} from "@/lib/monitor/checks.js";
import { measureSpeed, speedStatus, type SpeedResult } from "@/lib/monitor/speed.js";
import type { VeilleClient } from "@/lib/monitor/worker-client.js";
import { prisma } from "@/lib/prisma.js";
import type { PushPayload, PushService } from "@/lib/push/service.js";

export const HTTP_INTERVAL_MS = 5 * 60_000;
export const DAILY_MS = 23 * 3_600_000;
export const WEEKLY_MS = 6.5 * 86_400_000;
export const RAW_HTTP_RETENTION_MS = 7 * 86_400_000;
export const LONG_RETENTION_MS = 396 * 86_400_000;
export const EXPIRY_THRESHOLDS = [30, 14, 7] as const;
const HOUR_MS = 3_600_000;
/** Fenêtre des observations relues pour l'état courant (2 h : 24 contrôles du hub par cible). */
const RECENT_WINDOW_MS = 2 * 3_600_000;

export type MonitorDeps = {
  push: PushService;
  veille: VeilleClient;
  /** Par défaut : guardedFetch (adresse résolue une fois et vérifiée, jamais le réseau local). */
  fetch?: typeof fetch;
  /** Résolution des noms pour la garde réseau (HTTP, TLS, vitesse). */
  lookup?: HostLookup;
  tls?: TlsConnector;
  resolver?: DnsResolver;
  rdap?: RdapClient;
  /** null : vitesse indisponible ; undefined : HUB_CHROMIUM_PATH ou Chromium de playwright-core. */
  chromiumPath?: string | null;
  speed?: (url: string) => Promise<SpeedResult>;
  now?: () => number;
  /** Sonde de connectivité du hub (par défaut : internetReachable). */
  connectivity?: () => Promise<boolean>;
  /** Dossier des données : rapports PDF des cibles supprimées purgés. */
  dataDir?: string;
};

export type TargetWithSite = MonitorTarget & { site: Pick<Site, "id" | "slug" | "state"> | null };

type ObserverChecks = { hub: MonitorCheck[]; edge: MonitorCheck[] };

const toObservation = (c: MonitorCheck): HttpObservation => ({
  targetId: c.targetId,
  observer: c.observer as Observer,
  at: c.at.getTime(),
  ok: c.ok,
  status: c.status,
  ms: c.ms,
  reason: c.detail ? ((JSON.parse(c.detail) as { reason?: string | null }).reason ?? null) : null,
});

/** Échecs consécutifs transmis par le Worker avec l'observation, null s'ils sont absents. */
const reportedFailures = (c: MonitorCheck): number | null => {
  if (!c.detail) return null;
  const f = (JSON.parse(c.detail) as { failures?: unknown }).failures;
  return typeof f === "number" && Number.isInteger(f) && f >= 0 ? f : null;
};

/**
 * État d'un point de contrôle depuis ses dernières observations (les plus récentes en tête). Le Worker
 * transmet son nombre d'échecs consécutifs : il fait foi (le hub peut ne pas avoir vu chaque échec).
 */
export function observerStateOf(checks: MonitorCheck[]): ObserverState | null {
  if (checks.length === 0) return null;
  let failures = reportedFailures(checks[0]!);
  if (failures === null) {
    failures = 0;
    for (const c of checks) {
      if (c.ok) break;
      failures++;
    }
  }
  return { consecutiveFailures: failures, last: toObservation(checks[0]!) };
}

const formatDuration = (ms: number) => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
};

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await run(items[i++]!);
    }),
  );
}

export class MonitorService {
  readonly push: PushService;
  readonly veille: VeilleClient;
  private readonly fetchImpl: typeof fetch;
  private readonly tls: TlsConnector;
  private readonly resolver: DnsResolver;
  private readonly rdap: RdapClient;
  private readonly speed: (url: string) => Promise<SpeedResult>;
  private readonly dataDir: string | null;
  private readonly chromiumPath: string | null | undefined;
  readonly now: () => number;
  private readonly connectivity: () => Promise<boolean>;

  /** Points de contrôle et synchronisation, pour l'écran Surveillance. */
  readonly health = {
    edgeSeenAt: null as number | null,
    lastStateSince: 0,
    lastSyncAt: null as number | null,
    error: null as string | null,
    hubLastCycleAt: null as number | null,
    running: false,
    /** Incidents notifiés par le Worker (dernier GET /state), source de l'historique quand il est vivant. */
    edgeIncidents: null as StateResponse["incidents"] | null,
  };
  private timer: NodeJS.Timeout | null = null;
  private syncChain: Promise<void> = Promise.resolve();
  private lastPurgeAt = 0;
  private lastMonthlyKey: string | null = null;
  private cycle: Promise<void> | null = null;
  /** Rapport mensuel injecté par le service des rapports (évite une dépendance circulaire). */
  monthlyReports: ((month: string) => Promise<void>) | null = null;

  constructor(deps: MonitorDeps) {
    this.push = deps.push;
    this.veille = deps.veille;
    const lookup = deps.lookup ?? systemLookup;
    this.fetchImpl = deps.fetch ?? guardedFetch({ lookup });
    this.tls = deps.tls ?? makeTlsConnector(lookup);
    this.resolver = deps.resolver ?? defaultResolver();
    this.rdap = deps.rdap ?? new RdapClient({ fetch: this.fetchImpl });
    this.speed = deps.speed ?? ((url) => measureSpeed(url, { chromiumPath: deps.chromiumPath, lookup }));
    this.dataDir = deps.dataDir ?? null;
    this.chromiumPath = deps.chromiumPath;
    this.now = deps.now ?? Date.now;
    this.connectivity = deps.connectivity ?? (() => internetReachable());
  }

  /** Mesure de vitesse disponible, ou la raison de sa désactivation. */
  speedStatus(): Promise<{ available: boolean; reason: string | null }> {
    return speedStatus({ chromiumPath: this.chromiumPath });
  }

  // --- Cibles ---

  /** Cibles contrôlées : interrupteur actif, et site en ligne pour une version de travail (off = voulu). */
  async activeTargets(): Promise<TargetWithSite[]> {
    const targets = await prisma.monitorTarget.findMany({
      where: { enabled: true },
      include: { site: { select: { id: true, slug: true, state: true } } },
      orderBy: { createdAt: "asc" },
    });
    return targets.filter((t) => !(t.siteRole === "working" && t.site && t.site.state !== "ONLINE"));
  }

  /**
   * Incidents ouverts des cibles sorties de la surveillance (interrupteur coupé, site éteint) : clos à cet instant,
   * sans notification de retour. Sinon, au rallumage, toute la période compterait comme panne (audit du 27/10/2026).
   */
  async closeInactiveIncidents(): Promise<number> {
    const active = new Set((await this.activeTargets()).map((t) => t.id));
    const open = await prisma.monitorIncident.findMany({ where: { endedAt: null }, select: { id: true, targetId: true } });
    const stale = open.filter((i) => !active.has(i.targetId)).map((i) => i.id);
    if (stale.length === 0) return 0;
    const now = new Date(this.now());
    await prisma.monitorIncident.updateMany({ where: { id: { in: stale }, endedAt: null }, data: { endedAt: now, recoveredNotifiedAt: now } });
    return stale.length;
  }

  /** Configuration du Worker : cibles actives et abonnements. Sérialisée, jamais bloquante. */
  requestSync(): Promise<void> {
    this.syncChain = this.syncChain.then(async () => {
      if (!this.veille.configured) return;
      try {
        const targets: MonitorTargetSpec[] = (await this.activeTargets()).map((t) => ({ id: t.id, label: t.label, url: t.url, keyword: t.keyword }));
        const subscriptions = (await this.push.specs()).filter((s) => isAllowedPushEndpoint(s.endpoint));
        await this.veille.sync({ targets, subscriptions });
        this.health.lastSyncAt = this.now();
        this.health.error = null;
      } catch (err) {
        this.health.error = err instanceof Error ? err.message : "synchronisation impossible";
      }
    });
    return this.syncChain;
  }

  // --- Planificateur (en processus, un seul cycle à la fois) ---

  /** Planificateur lancé (serveur, jamais en test). */
  get started(): boolean {
    return this.timer !== null;
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    void this.requestSync();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
    setTimeout(() => void this.tick(), 5_000).unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.race([this.cycle ?? Promise.resolve(), new Promise((r) => setTimeout(r, 2000).unref())]);
  }

  /** Un passage : HTTP toutes les 5 min, quotidiens et hebdomadaires dus, purge, rapports du 1er. */
  tick(): Promise<void> {
    if (this.cycle) return this.cycle;
    this.cycle = (async () => {
      this.health.running = true;
      try {
        const now = this.now();
        if (!this.health.hubLastCycleAt || now - this.health.hubLastCycleAt >= HTTP_INTERVAL_MS - 5_000) await this.runHttpCycle();
        await this.runDueSlowChecks();
        if (now - this.lastPurgeAt >= 86_400_000) {
          await this.purge();
          this.lastPurgeAt = now;
        }
        // Mois de Paris, pas celui du fuseau de l'hôte (UTC sur le CT Alpine).
        const today = parisParts(now);
        if (today.day === 1 && this.monthlyReports) {
          const key = today.month === 1 ? `${today.year - 1}-12` : `${today.year}-${String(today.month - 1).padStart(2, "0")}`;
          if (this.lastMonthlyKey !== key) {
            this.lastMonthlyKey = key;
            await this.monthlyReports(key).catch((err) => console.error("[surveillance] rapports mensuels", err instanceof Error ? err.message : err));
          }
        }
      } catch (err) {
        console.error("[surveillance] cycle interrompu", err instanceof Error ? err.message : err);
      } finally {
        this.health.running = false;
        this.cycle = null;
      }
    })();
    return this.cycle;
  }

  // --- Contrôle HTTP (5 min), échange avec le Worker, décision ---

  async checkHttp(target: TargetWithSite): Promise<HttpObservation> {
    const at = this.now();
    const r = await httpCheck(target.url, { fetch: this.fetchImpl, keyword: target.keyword, now: this.now });
    await prisma.monitorCheck.create({
      data: { targetId: target.id, kind: "http", observer: "hub", at: new Date(at), ok: r.ok, status: r.status, ms: r.ms, detail: JSON.stringify({ reason: r.reason }) },
    });
    return { targetId: target.id, observer: "hub", at, ok: r.ok, status: r.status, ms: r.ms, reason: r.reason };
  }

  async runHttpCycle(): Promise<void> {
    await this.closeInactiveIncidents();
    const targets = await this.activeTargets();
    const observations: HttpObservation[] = [];
    await pool(targets, 8, async (t) => {
      observations.push(await this.checkHttp(t));
    });
    this.health.hubLastCycleAt = this.now();
    if (this.veille.configured) {
      try {
        await this.veille.report({ at: this.now(), observations });
      } catch (err) {
        this.health.error = err instanceof Error ? err.message : "rapport impossible";
      }
      await this.pullEdgeState();
    }
    // Coupure de la surveillance (box coupée) : aucun incident décidé tant qu'elle dure.
    if (!(await this.trackBlackout(observations))) await this.evaluate(targets);
    await this.aggregate(targets.map((t) => t.id), this.now());
  }

  /**
   * Coupure de la surveillance (décision d'Alexandre du 27/10/2026) : toutes les cibles tombent au même passage et la sonde
   * de connectivité échoue, c'est le hub qui n'a plus Internet. Une période MonitorBlackout s'ouvre, aucun incident n'est
   * ouvert ; elle se ferme au premier passage où la sonde répond, avec un avis à Alexandre. Ces périodes sortent du rapport
   * client et des statistiques de disponibilité (view.ts). Renvoie vrai tant qu'elle dure.
   */
  private async trackBlackout(observations: HttpObservation[]): Promise<boolean> {
    const open = await prisma.monitorBlackout.findFirst({ where: { endedAt: null } });
    const allFailed = observations.length > 0 && observations.every((o) => !o.ok);
    if (!open && !allFailed) return false;
    const online = await this.connectivity();
    const now = this.now();
    if (open) {
      if (!online) return true;
      await prisma.monitorBlackout.update({ where: { id: open.id }, data: { endedAt: new Date(now), notifiedAt: new Date(now) } });
      await this.notify({
        title: "Surveillance reprise",
        body: `Internet du hub coupé ${formatDuration(now - open.startedAt.getTime())} (depuis le ${frDateNumeric(open.startedAt)}) : aucune panne comptée pendant ce temps, période exclue des rapports clients.`,
        url: "/surveillance",
        urgent: false,
        tag: `coupure:${open.id}`,
      });
      return false;
    }
    if (online) return false;
    await prisma.monitorBlackout.create({
      data: { startedAt: new Date(now), cause: `hub sans Internet : ${CONNECTIVITY_PROBES.join(" et ")} injoignables`, targets: observations.length },
    });
    return true;
  }

  /**
   * GET /state : observations du Worker enregistrées (observateur « edge »). Changements depuis le
   * curseur et état courant de chaque cible, sans doublon : une ligne déjà présente pour (cible, at)
   * n'est jamais réinsérée (redémarrage du hub, curseur reparti de la base).
   */
  async pullEdgeState(): Promise<void> {
    try {
      if (this.health.lastStateSince === 0) {
        const last = await prisma.monitorCheck.findFirst({ where: { kind: "http", observer: "edge" }, orderBy: { at: "desc" }, select: { at: true } });
        if (last) this.health.lastStateSince = last.at.getTime();
      }
      const since = this.health.lastStateSince;
      const state = await this.veille.state(since);
      const known = new Set((await prisma.monitorTarget.findMany({ select: { id: true } })).map((t) => t.id));
      const byKey = new Map<string, EdgeObservation>();
      for (const o of [...(state.current ?? []), ...state.observations]) {
        if (o.observer === "edge" && known.has(o.targetId) && Number.isFinite(o.at)) byKey.set(`${o.targetId}|${o.at}`, o);
      }
      const candidates = [...byKey.values()];
      if (candidates.length > 0) {
        const existing = await prisma.monitorCheck.findMany({
          where: { kind: "http", observer: "edge", OR: candidates.map((o) => ({ targetId: o.targetId, at: new Date(o.at) })) },
          select: { targetId: true, at: true },
        });
        const present = new Set(existing.map((e) => `${e.targetId}|${e.at.getTime()}`));
        const fresh = candidates.filter((o) => !present.has(`${o.targetId}|${o.at}`));
        if (fresh.length > 0) {
          await prisma.monitorCheck.createMany({
            data: fresh.map((o) => ({
              targetId: o.targetId,
              kind: "http",
              observer: "edge",
              at: new Date(o.at),
              ok: o.ok,
              status: o.status,
              ms: o.ms,
              detail: JSON.stringify({ reason: o.reason?.slice(0, 120) ?? null, ...(typeof o.failures === "number" ? { failures: o.failures } : {}) }),
            })),
          });
        }
        this.health.lastStateSince = Math.max(since, ...candidates.map((o) => o.at));
      }
      this.health.edgeSeenAt = state.edgeSeenAt;
      this.health.edgeIncidents = state.incidents.filter((i) => known.has(i.targetId));
      this.health.error = null;
    } catch (err) {
      this.health.error = err instanceof Error ? err.message : "état du Worker illisible";
    }
  }

  /**
   * Worker vivant : ses incidents (ceux qu'il a notifiés) deviennent l'historique du hub, repérés par
   * (cible, début). Le hub n'en ouvre pas d'autres tant qu'il est vivant.
   */
  private async mirrorEdgeIncidents(targetIds: Set<string>, recent: Map<string, ObserverChecks>): Promise<Set<string>> {
    const mirrored = new Set<string>();
    for (const wi of this.health.edgeIncidents ?? []) {
      if (!targetIds.has(wi.targetId)) continue;
      const startedAt = new Date(wi.startedAt);
      const endedAt = wi.endedAt === null ? null : new Date(wi.endedAt);
      mirrored.add(`${wi.targetId}|${wi.startedAt}`);
      const existing = await prisma.monitorIncident.findFirst({ where: { targetId: wi.targetId, startedAt } });
      if (!existing) {
        const last = recent.get(wi.targetId)?.edge[0];
        await prisma.monitorIncident.create({
          data: {
            targetId: wi.targetId,
            startedAt,
            endedAt,
            cause: last && !last.ok ? toObservation(last).reason : null,
            observers: wi.basis.join(","),
            notifiedAt: startedAt,
            recoveredNotifiedAt: endedAt,
          },
        });
      } else if (endedAt && !existing.endedAt) {
        await prisma.monitorIncident.update({ where: { id: existing.id }, data: { endedAt, recoveredNotifiedAt: endedAt } });
      }
    }
    return mirrored;
  }

  /** Le Worker est-il configuré et vivant (vu depuis moins de 15 min) ? */
  edgeAlive(now = this.now()): boolean {
    return this.veille.configured && this.health.edgeSeenAt !== null && now - this.health.edgeSeenAt <= OBSERVER_STALE_MS;
  }

  /**
   * Dernières observations HTTP de chaque point, les plus récentes en tête. Le Worker n'envoie que les
   * changements d'état (chaque échec, puis le premier succès) : une cible stable n'a pas de ligne
   * récente côté « edge ». Sa dernière ligne, même ancienne, reste donc l'état courant (jusqu'à
   * edgeSeenAt). Deux requêtes pour toutes les cibles : fenêtre récente, puis dernière ligne manquante.
   */
  async recentChecks(targetIds: string[], now = this.now()): Promise<Map<string, ObserverChecks>> {
    const map = new Map<string, ObserverChecks>();
    for (const id of targetIds) map.set(id, { hub: [], edge: [] });
    if (targetIds.length === 0) return map;
    const rows = await prisma.monitorCheck.findMany({
      where: { targetId: { in: targetIds }, kind: "http", at: { gte: new Date(now - RECENT_WINDOW_MS) } },
      orderBy: { at: "desc" },
    });
    for (const r of rows) map.get(r.targetId)?.[r.observer === "edge" ? "edge" : "hub"].push(r);
    const missing = targetIds.flatMap((id) => (["hub", "edge"] as const).filter((o) => map.get(id)![o].length === 0).map((o) => ({ id, o })));
    if (missing.length > 0) {
      const latest = await prisma.monitorCheck.groupBy({
        by: ["targetId", "observer"],
        where: { kind: "http", OR: missing.map((m) => ({ targetId: m.id, observer: m.o })) },
        _max: { at: true },
      });
      if (latest.length > 0) {
        const older = await prisma.monitorCheck.findMany({
          where: { kind: "http", OR: latest.map((l) => ({ targetId: l.targetId, observer: l.observer, at: l._max.at! })) },
        });
        for (const r of older) map.get(r.targetId)?.[r.observer === "edge" ? "edge" : "hub"].push(r);
      }
    }
    return map;
  }

  decideFor(checks: ObserverChecks | undefined, now = this.now()): Decision {
    const hub = observerStateOf(checks?.hub ?? []);
    const edge = observerStateOf(checks?.edge ?? []);
    return decide({
      hub,
      edge,
      hubSeenAt: hub?.last?.at ?? this.health.hubLastCycleAt,
      edgeSeenAt: this.veille.configured ? (this.health.edgeSeenAt ?? edge?.last?.at ?? null) : null,
      now,
    });
  }

  /**
   * Décision du tableau 10.1 : incidents ouverts et fermés pour l'historique. Le hub n'envoie les
   * alertes urgentes que si le Worker n'est pas configuré ou se tait (sinon, c'est le Worker).
   */
  async evaluate(targets: TargetWithSite[]): Promise<void> {
    const now = this.now();
    const recent = await this.recentChecks(targets.map((t) => t.id), now);
    const hubAlerts = !this.edgeAlive(now);
    const mirrored = !hubAlerts && this.health.edgeIncidents ? await this.mirrorEdgeIncidents(new Set(targets.map((t) => t.id)), recent) : null;
    const open = await prisma.monitorIncident.findMany({ where: { targetId: { in: targets.map((t) => t.id) }, endedAt: null } });
    const openByTarget = new Map(open.map((i) => [i.targetId, i]));
    const why = this.veille.configured ? "décision du hub seul : surveillance Cloudflare interrompue" : "décision du hub seul : surveillance Cloudflare non configurée";
    const opened: Array<{ target: TargetWithSite; incident: MonitorIncident }> = [];

    for (const target of targets) {
      const checks = recent.get(target.id);
      const decision = this.decideFor(checks, now);
      const incident = openByTarget.get(target.id);
      // Incident tenu par le Worker : ouvert et fermé par lui seul (mirrorEdgeIncidents).
      if (mirrored && (!incident || mirrored.has(`${incident.targetId}|${incident.startedAt.getTime()}`))) continue;
      if (decision.verdict === "down" && !incident) {
        const cause = checks?.hub[0] ? toObservation(checks.hub[0]).reason : checks?.edge[0] ? toObservation(checks.edge[0]).reason : null;
        const created = await prisma.monitorIncident.create({
          data: { targetId: target.id, startedAt: new Date(now), cause, observers: decision.basis.join(",") },
        });
        opened.push({ target, incident: created });
      } else if (incident && this.recovered(decision)) {
        const ended = await prisma.monitorIncident.update({ where: { id: incident.id }, data: { endedAt: new Date(now) } });
        if (hubAlerts) {
          await this.notify({
            title: `Rétabli : ${target.label}`,
            body: `De nouveau joignable après ${formatDuration(now - ended.startedAt.getTime())} (${why}).`,
            url: "/surveillance",
            tag: `incident:${incident.id}:fin`,
            urgent: true,
          });
          await prisma.monitorIncident.update({ where: { id: incident.id }, data: { recoveredNotifiedAt: new Date(now) } });
        }
      } else if (incident && hubAlerts && now - (incident.reminderAt ?? incident.startedAt).getTime() >= INCIDENT_REMINDER_MS) {
        await this.notify({
          title: `Toujours en panne : ${target.label}`,
          body: `Panne depuis ${formatDuration(now - incident.startedAt.getTime())} (${why}).`,
          url: "/surveillance",
          tag: `incident:${incident.id}:rappel`,
          urgent: true,
        });
        await prisma.monitorIncident.update({ where: { id: incident.id }, data: { reminderAt: new Date(now) } });
      }
    }

    if (hubAlerts && opened.length > 0) {
      if (opened.length > GROUP_ALERT_THRESHOLD) {
        await this.notify({
          title: `${opened.length} sites en panne`,
          body: `${opened.map((o) => o.target.label).slice(0, 6).join(", ")}${opened.length > 6 ? "…" : ""} (${why}).`,
          url: "/surveillance",
          tag: `incidents:${now}`,
          urgent: true,
        });
      } else {
        for (const o of opened) {
          await this.notify({
            title: `Panne : ${o.target.label}`,
            body: `${o.incident.cause ?? "ne répond plus"} (${why}).`,
            url: "/surveillance",
            tag: `incident:${o.incident.id}`,
            urgent: true,
          });
        }
      }
      await prisma.monitorIncident.updateMany({ where: { id: { in: opened.map((o) => o.incident.id) } }, data: { notifiedAt: new Date(now) } });
    }

    if (this.veille.configured && !this.edgeAlive(now)) {
      const key = `edge-stale:${this.health.edgeSeenAt ?? "jamais"}`;
      await this.alertOnce(null, "edge_stale", key, {
        title: "Surveillance Cloudflare interrompue",
        body: "Le Worker de surveillance ne répond plus depuis plus de 15 minutes : le hub décide seul en attendant.",
        url: "/surveillance",
      });
    }
  }

  /** Fin d'incident comme le Worker : verdict up, local_only ou edge_only ; « unknown » le laisse ouvert. */
  private recovered(decision: Decision): boolean {
    return decision.verdict === "up" || decision.verdict === "local_only" || decision.verdict === "edge_only";
  }

  private async notify(payload: PushPayload): Promise<void> {
    try {
      const report = await this.push.sendToAll(payload);
      // Abonnements expirés (404, 410) supprimés par l'envoi : le Worker ne doit plus les recevoir.
      if (report.removed > 0) void this.requestSync();
    } catch (err) {
      console.error("[surveillance] notification impossible", err instanceof Error ? err.message : err);
    }
  }

  /** Alerte non urgente envoyée une seule fois par clé (anti-rafale). */
  async alertOnce(targetId: string | null, kind: string, dedupKey: string, payload: PushPayload): Promise<boolean> {
    const existing = await prisma.monitorAlert.findUnique({ where: { dedupKey } });
    if (existing) return false;
    await prisma.monitorAlert.create({ data: { targetId, kind, dedupKey } });
    await this.notify({ ...payload, tag: dedupKey });
    return true;
  }

  // --- Agrégats horaires (par point de contrôle) ---

  /**
   * Agrégats horaires. Hub : un contrôle par ligne. Worker : il n'envoie que les changements d'état,
   * l'heure est donc reconstituée en suivant l'état (dernier connu avant l'heure, puis chaque ligne)
   * jusqu'à edgeSeenAt, à raison d'un contrôle toutes les 5 minutes.
   */
  async aggregate(targetIds: string[], now: number): Promise<void> {
    if (targetIds.length === 0) return;
    const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
    for (const hour of [currentHour - HOUR_MS, currentHour]) {
      const rows = await prisma.monitorCheck.findMany({
        where: { targetId: { in: targetIds }, kind: "http", at: { gte: new Date(hour), lt: new Date(hour + HOUR_MS) } },
        select: { targetId: true, observer: true, ok: true, ms: true, at: true },
        orderBy: { at: "asc" },
      });
      const stats = (list: Array<{ ms: number | null }>) => {
        const times = list.map((r) => r.ms).filter((v): v is number => v !== null).sort((x, y) => x - y);
        return {
          avgMs: times.length ? Math.round(times.reduce((sum, v) => sum + v, 0) / times.length) : null,
          p95Ms: times.length ? times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)]! : null,
        };
      };
      const upsert = (targetId: string, observer: string, data: { checks: number; failures: number; avgMs: number | null; p95Ms: number | null }) =>
        prisma.monitorHourly.upsert({
          where: { targetId_hour_observer: { targetId, hour: new Date(hour), observer } },
          create: { targetId, hour: new Date(hour), observer, ...data },
          update: data,
        });

      for (const targetId of targetIds) {
        const hubRows = rows.filter((r) => r.targetId === targetId && r.observer === "hub");
        if (hubRows.length > 0) await upsert(targetId, "hub", { checks: hubRows.length, failures: hubRows.filter((r) => !r.ok).length, ...stats(hubRows) });
      }

      const edgeEnd = Math.min(hour + HOUR_MS, now, this.health.edgeSeenAt ?? 0);
      if (!this.veille.configured || edgeEnd <= hour) continue;
      const priorAt = await prisma.monitorCheck.groupBy({
        by: ["targetId"],
        where: { targetId: { in: targetIds }, kind: "http", observer: "edge", at: { lt: new Date(hour) } },
        _max: { at: true },
      });
      const prior = priorAt.length
        ? await prisma.monitorCheck.findMany({
            where: { kind: "http", observer: "edge", OR: priorAt.map((g) => ({ targetId: g.targetId, at: g._max.at! })) },
            select: { targetId: true, ok: true },
          })
        : [];
      for (const targetId of targetIds) {
        const edgeRows = rows.filter((r) => r.targetId === targetId && r.observer === "edge");
        let state: boolean | null = prior.find((p) => p.targetId === targetId)?.ok ?? null;
        let cursor = hour;
        let okMs = 0;
        let failMs = 0;
        for (const r of edgeRows) {
          if (state !== null) state ? (okMs += r.at.getTime() - cursor) : (failMs += r.at.getTime() - cursor);
          state = r.ok;
          cursor = r.at.getTime();
        }
        if (state !== null && edgeEnd > cursor) state ? (okMs += edgeEnd - cursor) : (failMs += edgeEnd - cursor);
        if (state === null) continue;
        const failingRows = edgeRows.filter((r) => !r.ok).length;
        const failures = Math.max(failingRows, Math.round(failMs / HTTP_INTERVAL_MS));
        const checks = Math.max(edgeRows.length, failures, Math.round((okMs + failMs) / HTTP_INTERVAL_MS));
        await upsert(targetId, "edge", { checks, failures, ...stats(edgeRows) });
      }
    }
  }

  // --- Contrôles quotidiens et hebdomadaires ---

  async runDueSlowChecks(): Promise<void> {
    const now = this.now();
    const targets = await this.activeTargets();
    if (targets.length === 0) return;
    const latest = await prisma.monitorCheck.groupBy({
      by: ["targetId", "kind"],
      where: { targetId: { in: targets.map((t) => t.id) }, kind: { in: ["tls", "domain", "dns", "content", "speed"] } },
      _max: { at: true },
    });
    const last = new Map(latest.map((l) => [`${l.targetId}|${l.kind}`, l._max.at?.getTime() ?? 0]));
    const due = (t: TargetWithSite, kind: string, every: number) => now - (last.get(`${t.id}|${kind}`) ?? 0) >= every;
    for (const t of targets) {
      if (due(t, "tls", DAILY_MS)) await this.checkTls(t);
      if (due(t, "domain", DAILY_MS)) await this.checkDomain(t);
      if (due(t, "dns", DAILY_MS)) await this.checkDns(t);
      if (due(t, "content", DAILY_MS)) await this.checkContent(t);
    }
    // Vitesse : une mesure par passage au plus (Chromium, une à la fois).
    const speedDue = targets.find((t) => due(t, "speed", WEEKLY_MS));
    if (speedDue) await this.checkSpeed(speedDue);
  }

  private async record(target: MonitorTarget, kind: string, ok: boolean, detail: unknown, extra: { status?: number | null; ms?: number | null } = {}): Promise<void> {
    await prisma.monitorCheck.create({
      data: { targetId: target.id, kind, observer: "hub", at: new Date(this.now()), ok, status: extra.status ?? null, ms: extra.ms ?? null, detail: JSON.stringify(detail) },
    });
  }

  /** Seuils de 30, 14 et 7 jours : une alerte au plus par seuil et par échéance (renouvellement = nouvelle échéance). */
  private async expiryAlert(target: MonitorTarget, kind: "tls" | "domain", expiresAt: string, daysLeft: number): Promise<void> {
    const crossed = EXPIRY_THRESHOLDS.filter((t) => daysLeft <= t);
    if (crossed.length === 0) return;
    const lowest = Math.min(...crossed);
    const keys = crossed.map((t) => `${kind}:${target.id}:${expiresAt.slice(0, 10)}:${t}`);
    const already = await prisma.monitorAlert.findMany({ where: { dedupKey: { in: keys } }, select: { dedupKey: true } });
    const sent = new Set(already.map((a) => a.dedupKey));
    const lowestKey = `${kind}:${target.id}:${expiresAt.slice(0, 10)}:${lowest}`;
    if (sent.has(lowestKey)) return;
    // Seuils plus larges franchis en même temps : marqués envoyés, une seule notification.
    for (const key of keys) if (!sent.has(key) && key !== lowestKey) await prisma.monitorAlert.create({ data: { targetId: target.id, kind: `${kind}_expiry`, dedupKey: key } });
    const what = kind === "tls" ? "Le certificat" : "Le nom de domaine";
    await this.alertOnce(target.id, `${kind}_expiry`, lowestKey, {
      title: `${what} expire dans ${Math.max(0, daysLeft)} jour${daysLeft > 1 ? "s" : ""}`,
      body: `${target.hostname} : échéance le ${frDateNumeric(new Date(expiresAt))}.`,
      url: "/surveillance",
    });
  }

  async checkTls(target: MonitorTarget): Promise<void> {
    if (!target.url.startsWith("https://")) return;
    const r = await tlsCheck(target.hostname, this.tls, this.now());
    await this.record(target, "tls", r.ok, r);
    if (r.error && r.validTo === null && r.error.startsWith("connexion")) return;
    if (r.error) {
      await this.alertOnce(target.id, "tls_invalid", `tls-invalid:${target.id}:${r.error}:${r.validTo ?? ""}`, {
        title: `Certificat invalide : ${target.hostname}`,
        body: r.error,
        url: "/surveillance",
        urgent: true,
      });
    } else if (r.validTo && r.daysLeft !== null) {
      await this.expiryAlert(target, "tls", r.validTo, r.daysLeft);
    }
  }

  async checkDomain(target: MonitorTarget): Promise<void> {
    try {
      const r = await this.rdap.lookup(target.hostname);
      const daysLeft = r.expiresAt ? daysUntil(new Date(r.expiresAt), this.now()) : null;
      await this.record(target, "domain", true, { ...r, daysLeft, domain: registrableDomain(target.hostname) });
      if (r.expiresAt && daysLeft !== null) await this.expiryAlert(target, "domain", r.expiresAt, daysLeft);
    } catch (err) {
      await this.record(target, "domain", false, { expiresAt: null, registrar: null, daysLeft: null, error: err instanceof Error ? err.message.slice(0, 120) : "RDAP indisponible" });
    }
  }

  async checkDns(target: MonitorTarget): Promise<void> {
    let snapshot: DnsSnapshot;
    try {
      snapshot = await dnsSnapshot(target.hostname, this.resolver);
    } catch (err) {
      await this.record(target, "dns", false, { status: "error", detail: err instanceof Error ? err.message.slice(0, 120) : "résolution impossible" });
      return;
    }
    if (!target.dnsReference) {
      await this.record(target, "dns", true, { status: "no_reference", snapshot });
      return;
    }
    const drift = dnsDrift(JSON.parse(target.dnsReference) as DnsSnapshot, snapshot);
    await this.record(target, "dns", drift.length === 0, { status: drift.length ? "drift" : "ok", snapshot, drift });
    if (drift.length > 0) {
      await this.alertOnce(target.id, "dns_drift", `dns:${target.id}:${JSON.stringify(snapshot)}`, {
        title: `DNS modifié : ${target.hostname}`,
        body: `Écart avec la référence : ${drift.join(", ")}. Vérifier, puis accepter comme référence si c'est voulu.`,
        url: "/surveillance",
      });
    }
  }

  async checkContent(target: MonitorTarget): Promise<void> {
    const r = await httpCheck(target.url, { fetch: this.fetchImpl, wantBody: true, now: this.now });
    if (!r.ok || r.body === null) {
      await this.record(target, "content", false, { status: "error", reason: r.reason });
      return;
    }
    const hash = contentHash(r.body);
    if (!target.contentHash) {
      await this.record(target, "content", true, { status: "no_reference", hash });
      return;
    }
    const changed = hash !== target.contentHash;
    await this.record(target, "content", !changed, { status: changed ? "changed" : "ok", hash });
    // Non urgent seulement : un contenu changé n'est jamais une panne.
    if (changed) {
      await this.alertOnce(target.id, "content_changed", `content:${target.id}:${hash}`, {
        title: `Accueil modifié : ${target.hostname}`,
        body: "Le contenu de l'accueil a changé sans publication par le hub. Vérifier, puis accepter comme nouvelle référence si c'est voulu.",
        url: "/surveillance",
      });
    }
  }

  async checkSpeed(target: MonitorTarget): Promise<void> {
    const r = await this.speed(target.url);
    if (!r.available) {
      await this.record(target, "speed", false, { available: false, reason: r.reason });
      return;
    }
    await this.record(target, "speed", r.ok, r, { ms: r.ttfbMs });
  }

  /** Accepte l'état DNS actuel comme référence. */
  async acceptDns(target: MonitorTarget): Promise<void> {
    const snapshot = await dnsSnapshot(target.hostname, this.resolver);
    await prisma.monitorTarget.update({ where: { id: target.id }, data: { dnsReference: JSON.stringify(snapshot), dnsReferenceAt: new Date(this.now()) } });
    await this.record(target, "dns", true, { status: "ok", snapshot, drift: [] });
    await audit({ action: "monitor.dns.accept", result: "ok", siteId: target.siteId, detail: target.hostname });
  }

  /** Accepte l'accueil actuel comme nouvelle référence de contenu. */
  async acceptContent(target: MonitorTarget): Promise<boolean> {
    const r = await httpCheck(target.url, { fetch: this.fetchImpl, wantBody: true, now: this.now });
    if (!r.ok || r.body === null) return false;
    const hash = contentHash(r.body);
    await prisma.monitorTarget.update({ where: { id: target.id }, data: { contentHash: hash, contentHashAt: new Date(this.now()) } });
    await this.record(target, "content", true, { status: "ok", hash });
    await audit({ action: "monitor.content.accept", result: "ok", siteId: target.siteId, detail: target.hostname });
    return true;
  }

  // --- Historique ---

  /**
   * Purge quotidienne : HTTP brut au-delà de 7 jours, sauf la dernière ligne de chaque couple (cible,
   * observateur), qui porte l'état courant (le Worker n'envoie que les changements) ; le reste au-delà
   * de 13 mois ; dossiers de rapports PDF des cibles supprimées (site supprimé en cascade).
   */
  async purge(now = this.now()): Promise<void> {
    const raw = new Date(now - RAW_HTTP_RETENTION_MS);
    const long = new Date(now - LONG_RETENTION_MS);
    const latest = await prisma.monitorCheck.groupBy({ by: ["targetId", "observer"], where: { kind: "http" }, _max: { at: true } });
    await prisma.monitorCheck.deleteMany({
      where: {
        kind: "http",
        at: { lt: raw },
        ...(latest.length ? { NOT: { OR: latest.map((l) => ({ targetId: l.targetId, observer: l.observer, at: l._max.at! })) } } : {}),
      },
    });
    await prisma.monitorCheck.deleteMany({ where: { kind: { not: "http" }, at: { lt: long } } });
    await prisma.monitorHourly.deleteMany({ where: { hour: { lt: long } } });
    await prisma.monitorIncident.deleteMany({ where: { endedAt: { lt: long } } });
    await prisma.monitorBlackout.deleteMany({ where: { endedAt: { lt: long } } });
    await prisma.monitorAlert.deleteMany({ where: { sentAt: { lt: long } } });
    await this.purgeOrphanReports();
  }

  /** Dossiers reports/<id> dont la cible n'existe plus. */
  private async purgeOrphanReports(): Promise<void> {
    if (!this.dataDir) return;
    const dir = path.join(this.dataDir, "reports");
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (ids.length === 0) return;
    const alive = new Set((await prisma.monitorTarget.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((t) => t.id));
    for (const id of ids) if (!alive.has(id)) await rm(path.join(dir, id), { recursive: true, force: true });
  }
}
