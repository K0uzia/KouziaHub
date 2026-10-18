// Lecture et écriture de l'état D1. Écritures groupées en une requête par sorte (json_each), pour rester
// loin des 50 requêtes par invocation et n'écrire que ce qui change (cadrage 10.2).
import type { HttpObservation, Observer, ObserverState } from "../../../apps/api/src/lib/monitor/core.js";
import type { D1PreparedStatement, Env } from "./env.js";

export type StateRow = {
  target_id: string;
  observer: Observer;
  failures: number;
  ok: number;
  status: number | null;
  ms: number | null;
  reason: string | null;
  at: number;
};

export const rowToObservation = (r: StateRow): HttpObservation => ({
  targetId: r.target_id,
  observer: r.observer,
  at: r.at,
  ok: r.ok === 1,
  status: r.status,
  ms: r.ms,
  reason: r.reason,
});

export const rowToState = (r: StateRow): ObserverState => ({ consecutiveFailures: r.failures, last: rowToObservation(r) });

/** Un état se réécrit seulement si le nombre d'échecs ou le résultat change (ou s'il n'existait pas). */
export const stateChanged = (prev: ObserverState | null, next: ObserverState) =>
  !prev || prev.consecutiveFailures !== next.consecutiveFailures || prev.last?.ok !== next.last?.ok;

export function upsertStatesStatement(env: Env, states: ObserverState[]): D1PreparedStatement {
  const rows = states.map((s) => ({
    t: s.last!.targetId,
    o: s.last!.observer,
    f: s.consecutiveFailures,
    k: s.last!.ok ? 1 : 0,
    s: s.last!.status,
    m: s.last!.ms,
    r: s.last!.reason,
    a: s.last!.at,
  }));
  return env.DB.prepare(
    `INSERT INTO state (target_id, observer, failures, ok, status, ms, reason, at)
     SELECT json_extract(value, '$.t'), json_extract(value, '$.o'), json_extract(value, '$.f'), json_extract(value, '$.k'),
            json_extract(value, '$.s'), json_extract(value, '$.m'), json_extract(value, '$.r'), json_extract(value, '$.a')
     FROM json_each(?1) WHERE true
     ON CONFLICT (target_id, observer) DO UPDATE SET failures = excluded.failures, ok = excluded.ok, status = excluded.status,
       ms = excluded.ms, reason = excluded.reason, at = excluded.at`,
  ).bind(JSON.stringify(rows));
}

/** Valeurs de meta : null efface la valeur. */
export function setMetaStatement(env: Env, values: Record<string, number | string | null>): D1PreparedStatement {
  const rows = Object.entries(values).map(([k, v]) => ({ k, v: v === null ? null : String(v) }));
  return env.DB.prepare(
    `INSERT INTO meta (key, value) SELECT json_extract(value, '$.k'), json_extract(value, '$.v') FROM json_each(?1) WHERE true
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).bind(JSON.stringify(rows));
}

export const metaNumber = (rows: Array<{ key: string; value: string | null }>, key: string): number | null => {
  const v = rows.find((r) => r.key === key)?.value;
  return v === null || v === undefined || v === "" ? null : Number(v);
};
