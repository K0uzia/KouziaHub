// Passage planifié (chaque minute) : contrôle de la tranche de la minute, décision par decide() avec
// l'état du hub, incidents, silence du hub, puis envoi d'une partie de la file de notifications.
import {
  INCIDENT_REMINDER_MS,
  OBSERVER_STALE_MS,
  decide,
  nextObserverState,
  type MonitorTargetSpec,
  type Observer,
  type ObserverState,
} from "../../../apps/api/src/lib/monitor/core.js";
import { Budget, checkTarget, pool, slotAt } from "./checks.js";
import { MAX_CHECK_SUBREQUESTS, MAX_CONCURRENCY, PUSH_PER_PASS, SUBREQUEST_LIMIT, type Deps, type Env } from "./env.js";
import {
  buildNotifications,
  enqueueStatement,
  flushQueue,
  hubOfflineNotification,
  type FlushReport,
  type Opening,
  type PushPayload,
  type Recovery,
  type Reminder,
} from "./push.js";
import { metaNumber, rowToState, setMetaStatement, stateChanged, upsertStatesStatement, type StateRow } from "./state.js";

type TargetRow = { id: string; label: string; url: string; keyword: string | null };
type IncidentRow = { id: number; target_id: string; started_at: number; reminder_at: number | null };
type MetaRow = { key: string; value: string | null };

export type CycleReport = {
  slot: number;
  checked: number;
  skipped: number;
  stateWrites: number;
  notifications: number;
  push: FlushReport;
};

/** Ordre de la tranche décalé à chaque tour : une cible coupée faute de budget passe en tête au suivant. */
function rotate<T>(items: T[], now: number): T[] {
  if (items.length === 0) return items;
  const k = Math.floor(now / 300_000) % items.length;
  return [...items.slice(k), ...items.slice(0, k)];
}

export async function runCycle(env: Env, deps: Deps, now: number): Promise<CycleReport> {
  const slot = slotAt(now);
  const [targetsRes, statesRes, incidentsRes, metaRes] = await env.DB.batch([
    env.DB.prepare("SELECT id, label, url, keyword FROM targets WHERE slot = ?1 ORDER BY id").bind(slot),
    env.DB.prepare("SELECT * FROM state WHERE target_id IN (SELECT id FROM targets WHERE slot = ?1)").bind(slot),
    env.DB.prepare(
      "SELECT id, target_id, started_at, reminder_at FROM incidents WHERE ended_at IS NULL AND target_id IN (SELECT id FROM targets WHERE slot = ?1)",
    ).bind(slot),
    env.DB.prepare("SELECT key, value FROM meta WHERE key IN ('hub_seen_at', 'hub_offline_since')"),
  ]);
  const targets = (targetsRes!.results as unknown as TargetRow[]).map(
    (t): MonitorTargetSpec => ({ id: t.id, label: t.label, url: t.url, keyword: t.keyword }),
  );
  const states = statesRes!.results as unknown as StateRow[];
  const hubStates = new Map<string, ObserverState>();
  const edgeStates = new Map<string, ObserverState>();
  for (const r of states) (r.observer === "hub" ? hubStates : edgeStates).set(r.target_id, rowToState(r));
  const openIncidents = new Map((incidentsRes!.results as unknown as IncidentRow[]).map((i) => [i.target_id, i]));
  const meta = metaRes!.results as unknown as MetaRow[];
  const hubSeenAt = metaNumber(meta, "hub_seen_at");
  const hubOfflineSince = metaNumber(meta, "hub_offline_since");

  // --- Contrôles ---
  const budget = new Budget(MAX_CHECK_SUBREQUESTS);
  const results = await pool(rotate(targets, now), MAX_CONCURRENCY, (t) => checkTarget(t, deps, budget, now));
  const usedSubrequests = MAX_CHECK_SUBREQUESTS - budget.left;

  // --- Décisions ---
  const stateWrites: ObserverState[] = [];
  const openings: Opening[] = [];
  const recoveries: Recovery[] = [];
  const reminders: Reminder[] = [];
  const byId = new Map(targets.map((t) => [t.id, t]));
  let checked = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.skipped) {
      skipped += 1;
      continue;
    }
    checked += 1;
    const target = byId.get(r.obs.targetId)!;
    const prev = edgeStates.get(target.id) ?? null;
    const next = nextObserverState(prev, r.obs);
    if (stateChanged(prev, next)) stateWrites.push(next);
    const decision = decide({ hub: hubStates.get(target.id) ?? null, edge: next, hubSeenAt, edgeSeenAt: now, now });
    const open = openIncidents.get(target.id);
    if (decision.verdict === "down") {
      if (!open) {
        openings.push({ targetId: target.id, label: target.label, reason: r.obs.reason, basis: decision.basis as Observer[] });
      } else if (now - (open.reminder_at ?? open.started_at) >= INCIDENT_REMINDER_MS) {
        reminders.push({ targetId: target.id, label: target.label, startedAt: open.started_at, incidentId: open.id });
      }
    } else if (open && decision.verdict !== "unknown") {
      // up, local_only ou edge_only : la cible n'est plus en panne au sens du tableau 10.1.
      recoveries.push({ targetId: target.id, label: target.label, startedAt: open.started_at });
    }
  }

  const payloads: PushPayload[] = buildNotifications(now, openings, recoveries, reminders);
  const metaValues: Record<string, number | string | null> = { edge_seen_at: now };
  if (hubSeenAt !== null && now - hubSeenAt > OBSERVER_STALE_MS && hubOfflineSince === null) {
    payloads.push(hubOfflineNotification());
    metaValues.hub_offline_since = hubSeenAt;
  }

  // --- Écritures : une seule série, la ligne edge_seen_at est la seule écrite à chaque passage ---
  const writes = [setMetaStatement(env, metaValues)];
  if (stateWrites.length) writes.push(upsertStatesStatement(env, stateWrites));
  if (openings.length) {
    writes.push(
      env.DB.prepare(
        `INSERT INTO incidents (target_id, started_at, basis, notified_at)
         SELECT json_extract(value, '$.t'), ?2, json_extract(value, '$.b'), ?2 FROM json_each(?1)`,
      ).bind(JSON.stringify(openings.map((o) => ({ t: o.targetId, b: o.basis.join(",") }))), now),
    );
  }
  if (recoveries.length) {
    writes.push(
      env.DB.prepare(
        "UPDATE incidents SET ended_at = ?2, recovered_notified_at = ?2 WHERE ended_at IS NULL AND target_id IN (SELECT value FROM json_each(?1))",
      ).bind(JSON.stringify(recoveries.map((r) => r.targetId)), now),
    );
  }
  if (reminders.length) {
    writes.push(
      env.DB.prepare("UPDATE incidents SET reminder_at = ?2 WHERE id IN (SELECT value FROM json_each(?1))").bind(
        JSON.stringify(reminders.map((r) => r.incidentId)),
        now,
      ),
    );
  }
  if (payloads.length) writes.push(enqueueStatement(env, now, payloads));
  await env.DB.batch(writes);

  // --- Envoi : plafond par passage et sous-requêtes restantes ---
  const cap = Math.min(PUSH_PER_PASS, SUBREQUEST_LIMIT - usedSubrequests);
  const push = await flushQueue(env, deps, now, cap);

  return { slot, checked, skipped, stateWrites: stateWrites.length, notifications: payloads.length, push };
}
