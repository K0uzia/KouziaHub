// Outils de test : D1 simulé sur SQLite, réseau simulé, horloge, requêtes signées, clés VAPID locales.
// Aucun appel réseau réel.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { signRequest, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "../../../apps/api/src/lib/monitor/core.js";
import { slotOf } from "../src/checks.js";
import type { D1Database, D1PreparedStatement, D1Result, Deps, Env } from "../src/env.js";
import { SCHEMA_FILE } from "../tools/bundle.js";
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64url");

/** Paire VAPID au format web-push (clé publique brute 65 octets, clé privée d en 32 octets). */
export async function makeVapid() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as { publicKey: CryptoKey; privateKey: CryptoKey };
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  return { subject: "mailto:test@example.com", publicKey: b64url(raw), privateKey: jwk.d! };
}

/** Abonnement comme le donnerait un navigateur (p256dh, auth). */
export async function makeSubscription(endpoint = "https://push.example.com/abc") {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as { publicKey: CryptoKey; privateKey: CryptoKey };
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { endpoint, expirationTime: null, keys: { p256dh: b64url(raw), auth: b64url(auth) } };
}

// --- D1 simulé sur un vrai SQLite (node:sqlite) : schema.sql et toutes les requêtes sont exécutés ---

type SqlValue = null | number | bigint | string | Uint8Array;

export function makeD1() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(SCHEMA_FILE, "utf8"));
  const log: string[] = [];
  const stmt = (sql: string, params: SqlValue[] = []): D1PreparedStatement & { exec(): D1Result } => ({
    bind: (...values: unknown[]) => stmt(sql, values as SqlValue[]),
    exec() {
      log.push(sql.replace(/\s+/g, " ").trim());
      const rows = raw.prepare(sql).all(...params) as Record<string, unknown>[];
      return { results: rows, success: true };
    },
    async first<T>() {
      return ((this.exec().results[0] as T) ?? null) as T | null;
    },
    async all<T>() {
      return this.exec() as unknown as D1Result<T>;
    },
    async run() {
      return this.exec();
    },
  });
  const db: D1Database = {
    prepare: (sql) => stmt(sql),
    async batch<T>(statements: D1PreparedStatement[]) {
      raw.exec("BEGIN");
      try {
        const out = statements.map((s) => (s as ReturnType<typeof stmt>).exec());
        raw.exec("COMMIT");
        return out as unknown as D1Result<T>[];
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
    },
  };
  const rows = <T = Record<string, unknown>>(sql: string, ...params: SqlValue[]) => raw.prepare(sql).all(...params) as T[];
  return { db, raw, log, rows };
}

export const SECRET = "secret-de-test-partage-0123456789";

// 12:00 UTC : un multiple de 5 minutes, donc la tranche 0.
export const BASE = Date.UTC(2026, 9, 18, 12, 0, 0);
/** Instant du tour `round` (5 min chacun) où la tranche `slot` est contrôlée. */
export const at = (slot: number, round = 0, plusMs = 0) => BASE + round * 300_000 + slot * 60_000 + plusMs;

/** n identifiants qui tombent dans la tranche voulue. */
export function idsInSlot(slot: number, n: number, prefix = "t"): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) if (slotOf(`${prefix}${i}`) === slot) out.push(`${prefix}${i}`);
  return out;
}

export type FakeReply = { status: number; body?: string; headers?: Record<string, string> } | "timeout" | "error";

/** Réseau simulé : une règle par URL (exacte), appels enregistrés. Rien ne sort de la machine. */
export function makeNet(rules: Record<string, FakeReply | ((call: number) => FakeReply)> = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const counts = new Map<string, number>();
  const fetch: Deps["fetch"] = async (url, init) => {
    calls.push({ url, init });
    const n = (counts.get(url) ?? 0) + 1;
    counts.set(url, n);
    const rule = rules[url];
    const reply = typeof rule === "function" ? rule(n) : (rule ?? { status: 200, body: "<html>ok</html>" });
    if (reply === "timeout") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    if (reply === "error") throw new TypeError("network");
    return new Response(reply.status === 204 || reply.status === 304 ? null : (reply.body ?? ""), { status: reply.status, headers: reply.headers });
  };
  return { fetch, calls, rules };
}

export function makeEnv(db: D1Database, vapid?: { subject: string; publicKey: string; privateKey: string }): Env {
  return {
    DB: db,
    MONITOR_SHARED_SECRET: SECRET,
    VAPID_SUBJECT: vapid?.subject,
    VAPID_PUBLIC_KEY: vapid?.publicKey,
    VAPID_PRIVATE_KEY: vapid?.privateKey,
  };
}

/** Requête signée comme le ferait le hub. */
export async function signed(method: "GET" | "POST", path: string, body: unknown, nowMs: number, secret = SECRET): Promise<Request> {
  const text = body === undefined ? "" : JSON.stringify(body);
  const ts = String(Math.floor(nowMs / 1000));
  const pathname = new URL(path, "https://veille.example.workers.dev").pathname;
  const sig = await signRequest(secret, ts, method, pathname, text);
  return new Request(new URL(path, "https://veille.example.workers.dev"), {
    method,
    headers: { [TIMESTAMP_HEADER]: ts, [SIGNATURE_HEADER]: sig, "content-type": "application/json" },
    body: method === "POST" ? text : undefined,
  });
}
