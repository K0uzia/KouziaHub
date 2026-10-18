// Points d'entrée du Worker (cadrage 10.1 et 10.9) : POST /sync, POST /report, GET /state, signés
// (HMAC-SHA256 horodaté, secret MONITOR_SHARED_SECRET). Tout le reste et tout refus : la même 404.
import {
  PROTOCOL_VERSION,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  isAllowedPushEndpoint,
  nextObserverState,
  verifyRequest,
  type HttpObservation,
  type MonitorTargetSpec,
  type ObserverState,
  type PushSubscriptionSpec,
  type ReportBody,
  type StateResponse,
  type SyncBody,
} from "../../../apps/api/src/lib/monitor/core.js";
import { slotOf } from "./checks.js";
import { MAX_BODY_BYTES, MAX_OBSERVATIONS, MAX_SUBSCRIPTIONS, MAX_TARGETS, type Deps, type Env } from "./env.js";
import { enqueueStatement, hubBackNotification } from "./push.js";
import { metaNumber, rowToEdgeObservation, rowToState, setMetaStatement, stateChanged, upsertStatesStatement, type StateRow } from "./state.js";

/** Réponse unique de tout refus : même statut, même corps, mêmes en-têtes. */
export const notFound = () => new Response("Not Found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

const json = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

/** Lit le corps sans dépasser `max` octets ; null si trop gros. */
async function readLimited(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

// --- Validation (sans bibliothèque : le script regroupé reste petit) ---

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const httpUrl = (v: unknown): v is string => {
  if (!str(v, 2048)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};

export function parseSync(raw: unknown): SyncBody | null {
  if (!isObj(raw) || raw.v !== PROTOCOL_VERSION || !Array.isArray(raw.targets) || !Array.isArray(raw.subscriptions)) return null;
  if (raw.targets.length > MAX_TARGETS || raw.subscriptions.length > MAX_SUBSCRIPTIONS) return null;
  const targets: MonitorTargetSpec[] = [];
  const ids = new Set<string>();
  for (const t of raw.targets) {
    if (!isObj(t) || !str(t.id, 64) || !/^[A-Za-z0-9_-]+$/.test(t.id) || ids.has(t.id)) return null;
    if (!str(t.label, 200) || !httpUrl(t.url)) return null;
    if (t.keyword !== null && t.keyword !== undefined && !str(t.keyword, 200)) return null;
    ids.add(t.id);
    targets.push({ id: t.id, label: t.label, url: t.url, keyword: (t.keyword as string | null | undefined) ?? null });
  }
  const subscriptions: PushSubscriptionSpec[] = [];
  for (const s of raw.subscriptions) {
    if (!isObj(s) || !str(s.endpoint, 1024) || !isAllowedPushEndpoint(s.endpoint) || !isObj(s.keys)) return null;
    if (!str(s.keys.p256dh, 200) || !str(s.keys.auth, 100)) return null;
    subscriptions.push({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });
  }
  return { v: PROTOCOL_VERSION, targets, subscriptions };
}

export function parseReport(raw: unknown): ReportBody | null {
  if (!isObj(raw) || raw.v !== PROTOCOL_VERSION || typeof raw.at !== "number" || !Array.isArray(raw.observations)) return null;
  if (raw.observations.length > MAX_OBSERVATIONS) return null;
  const observations: HttpObservation[] = [];
  for (const o of raw.observations) {
    if (!isObj(o) || !str(o.targetId, 64) || o.observer !== "hub" || typeof o.at !== "number" || typeof o.ok !== "boolean") return null;
    const status = typeof o.status === "number" ? o.status : null;
    const ms = typeof o.ms === "number" ? Math.round(o.ms) : null;
    const reason = typeof o.reason === "string" ? o.reason.slice(0, 200) : null;
    observations.push({ targetId: o.targetId, observer: "hub", at: o.at, ok: o.ok, status, ms, reason });
  }
  return { v: PROTOCOL_VERSION, at: raw.at, observations };
}

// --- Traitements ---

/** Remplace la configuration : cibles, abonnements ; états, incidents et file des éléments retirés. */
async function handleSync(env: Env, body: SyncBody) {
  const targets = JSON.stringify(body.targets.map((t) => ({ ...t, slot: slotOf(t.id) })));
  const ids = JSON.stringify(body.targets.map((t) => t.id));
  const subs = JSON.stringify(body.subscriptions.map((s) => ({ e: s.endpoint, p: s.keys.p256dh, a: s.keys.auth })));
  const keep = "(SELECT value FROM json_each(?1))";
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM state WHERE target_id NOT IN ${keep}`).bind(ids),
    env.DB.prepare(`DELETE FROM incidents WHERE target_id NOT IN ${keep}`).bind(ids),
    env.DB.prepare(`DELETE FROM targets WHERE id NOT IN ${keep}`).bind(ids),
    env.DB.prepare(
      `INSERT INTO targets (id, label, url, keyword, slot)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.label'), json_extract(value, '$.url'),
              json_extract(value, '$.keyword'), json_extract(value, '$.slot')
       FROM json_each(?1) WHERE true
       ON CONFLICT (id) DO UPDATE SET label = excluded.label, url = excluded.url, keyword = excluded.keyword, slot = excluded.slot`,
    ).bind(targets),
    env.DB.prepare("DELETE FROM subscriptions WHERE endpoint NOT IN (SELECT json_extract(value, '$.e') FROM json_each(?1))").bind(subs),
    env.DB.prepare(
      `INSERT INTO subscriptions (endpoint, p256dh, auth)
       SELECT json_extract(value, '$.e'), json_extract(value, '$.p'), json_extract(value, '$.a') FROM json_each(?1) WHERE true
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
    ).bind(subs),
    env.DB.prepare("DELETE FROM push_queue WHERE endpoint NOT IN (SELECT endpoint FROM subscriptions)"),
  ]);
  return json({ ok: true, targets: body.targets.length, subscriptions: body.subscriptions.length });
}

/** Observations du hub : états réécrits seulement s'ils changent ; battement de cœur ; retour du hub. */
async function handleReport(env: Env, body: ReportBody, now: number) {
  const ids = JSON.stringify([...new Set(body.observations.map((o) => o.targetId))]);
  const [statesRes, knownRes, metaRes] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM state WHERE observer = 'hub' AND target_id IN (SELECT value FROM json_each(?1))").bind(ids),
    env.DB.prepare("SELECT id FROM targets WHERE id IN (SELECT value FROM json_each(?1))").bind(ids),
    env.DB.prepare("SELECT key, value FROM meta WHERE key = 'hub_offline_since'"),
  ]);
  const known = new Set((knownRes!.results as Array<{ id: string }>).map((r) => r.id));
  const current = new Map<string, ObserverState>();
  for (const r of statesRes!.results as unknown as StateRow[]) current.set(r.target_id, rowToState(r));
  const initial = new Map(current);

  for (const obs of [...body.observations].sort((a, b) => a.at - b.at)) {
    if (!known.has(obs.targetId)) continue;
    current.set(obs.targetId, nextObserverState(current.get(obs.targetId) ?? null, obs));
  }
  const changed = [...current.entries()].filter(([id, s]) => stateChanged(initial.get(id) ?? null, s)).map(([, s]) => s);

  const offlineSince = metaNumber(metaRes!.results as Array<{ key: string; value: string | null }>, "hub_offline_since");
  const writes = [setMetaStatement(env, { hub_seen_at: now, ...(offlineSince !== null ? { hub_offline_since: null } : {}) })];
  if (changed.length) writes.push(upsertStatesStatement(env, changed));
  // La notification de retour part au prochain passage planifié (une minute au plus).
  if (offlineSince !== null) writes.push(enqueueStatement(env, now, [hubBackNotification(now, offlineSince)]));
  await env.DB.batch(writes);
  return json({ ok: true, accepted: body.observations.filter((o) => known.has(o.targetId)).length });
}

/**
 * Changements depuis « since » et état courant de chaque cible (une ligne par cible : une cible stable
 * n'a aucun changement récent), avec le nombre d'échecs consécutifs.
 */
async function handleState(env: Env, since: number, now: number) {
  const [obsRes, incRes, metaRes] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM state WHERE observer = 'edge'"),
    env.DB.prepare(
      "SELECT target_id, started_at, ended_at, basis FROM incidents WHERE ended_at IS NULL OR ended_at >= ?1 OR started_at >= ?1 ORDER BY started_at DESC LIMIT 1000",
    ).bind(since),
    env.DB.prepare("SELECT key, value FROM meta WHERE key IN ('edge_seen_at', 'hub_seen_at')"),
  ]);
  const meta = metaRes!.results as Array<{ key: string; value: string | null }>;
  const current = (obsRes!.results as unknown as StateRow[]).map(rowToEdgeObservation);
  const body: StateResponse = {
    v: PROTOCOL_VERSION,
    now,
    edgeSeenAt: metaNumber(meta, "edge_seen_at"),
    hubSeenAt: metaNumber(meta, "hub_seen_at"),
    observations: current.filter((o) => o.at >= since),
    current,
    incidents: (incRes!.results as Array<{ target_id: string; started_at: number; ended_at: number | null; basis: string }>).map((i) => ({
      targetId: i.target_id,
      startedAt: i.started_at,
      endedAt: i.ended_at,
      basis: i.basis.split(",").filter((b): b is "hub" | "edge" => b === "hub" || b === "edge"),
    })),
  };
  return json(body);
}

/**
 * Anti-rejeu : l'horodatage signé doit dépasser le dernier accepté pour la route (gardé dans meta).
 * Une seule requête, atomique : la ligne n'est rendue que si elle a été insérée ou relevée.
 */
async function claimTimestamp(env: Env, route: string, timestamp: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?1, ?2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE CAST(meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)
     RETURNING value`,
  )
    .bind(`last_ts:${route}`, timestamp)
    .first();
  return row !== null;
}

export async function handleFetch(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  if (!env.MONITOR_SHARED_SECRET || !["POST /sync", "POST /report", "GET /state"].includes(route)) return notFound();

  const body = request.method === "POST" ? await readLimited(request, MAX_BODY_BYTES) : "";
  if (body === null) return notFound();
  const now = deps.now();
  const signed = await verifyRequest(
    env.MONITOR_SHARED_SECRET,
    { timestamp: request.headers.get(TIMESTAMP_HEADER), signature: request.headers.get(SIGNATURE_HEADER) },
    request.method,
    `${url.pathname}${url.search}`,
    body,
    now,
  );
  if (!signed) return notFound();
  // Horodatage consommé seulement par une requête signée et valide (après lecture du contenu).
  const fresh = () => claimTimestamp(env, route, request.headers.get(TIMESTAMP_HEADER)!);

  if (route === "GET /state") {
    if (!(await fresh())) return notFound();
    const since = Number(url.searchParams.get("since") ?? "0");
    return handleState(env, Number.isFinite(since) && since >= 0 ? since : 0, now);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return notFound();
  }
  if (route === "POST /sync") {
    const parsed = parseSync(raw);
    return parsed && (await fresh()) ? handleSync(env, parsed) : notFound();
  }
  const parsed = parseReport(raw);
  return parsed && (await fresh()) ? handleReport(env, parsed, now) : notFound();
}
