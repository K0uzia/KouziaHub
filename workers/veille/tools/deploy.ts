// Déploiement du Worker « kouzia-veille » par l'API Cloudflare (cadrage 10.3 et 10.9), sans wrangler.
// Jeton de déploiement : Account > Workers Scripts > Edit et Account > D1 > Edit, rien d'autre. Il est
// reçu en paramètre, jamais écrit ni journalisé : toute sortie passe par redact().
// fetch, horloge et attente sont injectables : les tests utilisent un faux serveur, aucun appel réel.
import { PROTOCOL_VERSION, SIGNATURE_HEADER, TIMESTAMP_HEADER, signRequest } from "../../../apps/api/src/lib/monitor/core.js";

export const WORKER_NAME = "kouzia-veille";
export const D1_NAME = "kouzia-veille";
export const CRON = "* * * * *";
/** Date de compatibilité du runtime Workers, figée : la changer est une décision (comportements). */
export const COMPATIBILITY_DATE = "2026-10-01";
const API = "https://api.cloudflare.com/client/v4";

export type DeployDeps = {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  randomSecret: () => string;
};

export type DeployInput = {
  token: string;
  /** Contenu du .env du hub. */
  env: Record<string, string>;
  /** Script regroupé (module ES unique). */
  script: string;
  schemaSql: string;
};

export type DeployResult = {
  workerUrl: string;
  databaseId: string;
  /** Valeurs à écrire dans le .env du hub (MONITOR_WORKER_URL, et MONITOR_SHARED_SECRET s'il a été créé). */
  envUpdates: Record<string, string>;
};

export class DeployError extends Error {}

type CfEnvelope<T> = { success: boolean; errors?: Array<{ code: number; message: string }>; result: T };

/** Instructions SQL de schema.sql, une par requête (commentaires retirés). */
export function splitSql(sql: string): string[] {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function deployVeille(input: DeployInput, deps: DeployDeps): Promise<DeployResult> {
  const secrets = new Set<string>([input.token]);
  const redact = (s: string) => {
    let out = s;
    for (const v of secrets) if (v && v.length >= 6) out = out.split(v).join("***");
    return out;
  };
  const log = (line: string) => deps.log(redact(line));
  const fail = (message: string): never => {
    throw new DeployError(redact(message));
  };

  async function cf<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<{ status: number; data: CfEnvelope<T> | null }> {
    const headers: Record<string, string> = { authorization: `Bearer ${input.token}` };
    let payload: RequestInit["body"] = init.body ?? undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await deps.fetch(`${API}${path}`, { method, headers, body: payload });
    } catch (err) {
      return fail(`Cloudflare injoignable (${err instanceof Error ? err.message : "réseau"}).`);
    }
    const data = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
    return { status: res.status, data };
  }
  const errText = (r: { status: number; data: CfEnvelope<unknown> | null }) =>
    (r.data?.errors ?? []).map((e) => `${e.code} ${e.message}`).join(" ; ") || `HTTP ${r.status}`;
  async function ok<T>(what: string, method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
    const r = await cf<T>(method, path, body, init);
    if (r.status === 401 || r.status === 403) {
      fail(`${what} : jeton refusé (${errText(r)}). Droits attendus : Account > Workers Scripts > Edit et Account > D1 > Edit, sur votre compte.`);
    }
    if (r.status < 200 || r.status >= 300 || !r.data?.success) fail(`${what} : échec (${errText(r)}).`);
    return r.data!.result;
  }

  // --- Compte ---
  let accountId = input.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  if (!accountId) {
    const accounts = await ok<Array<{ id: string; name: string }>>("Liste des comptes", "GET", "/accounts");
    if (accounts.length !== 1) fail("Plusieurs comptes ou aucun : renseignez CLOUDFLARE_ACCOUNT_ID (hubctl secrets api).");
    accountId = accounts[0]!.id;
  }
  if (!/^[0-9a-f]{32}$/i.test(accountId)) fail("CLOUDFLARE_ACCOUNT_ID invalide (32 caractères attendus).");
  const acct = `/accounts/${accountId}`;

  // --- Clés VAPID : sans elles, la veille ne pourrait rien envoyer ---
  const vapid = { VAPID_PUBLIC_KEY: input.env.VAPID_PUBLIC_KEY?.trim(), VAPID_PRIVATE_KEY: input.env.VAPID_PRIVATE_KEY?.trim(), VAPID_SUBJECT: input.env.VAPID_SUBJECT?.trim() };
  if (!vapid.VAPID_PUBLIC_KEY || !vapid.VAPID_PRIVATE_KEY || !vapid.VAPID_SUBJECT) {
    fail("Clés des notifications absentes du .env : lancez d'abord « hubctl push-keys ».");
  }
  for (const v of Object.values(vapid)) secrets.add(v!);

  // --- Sous-domaine workers.dev du compte (avant toute modification) ---
  log("1/7 Adresse workers.dev du compte...");
  const sub = await cf<{ subdomain?: string }>("GET", `${acct}/workers/subdomain`);
  if (sub.status === 401 || sub.status === 403) fail(`Jeton refusé (${errText(sub)}). Droits attendus : Account > Workers Scripts > Edit et Account > D1 > Edit.`);
  const subdomain = sub.data?.success ? sub.data.result?.subdomain?.trim() : "";
  if (!subdomain) {
    fail(
      "Votre compte n'a pas encore d'adresse workers.dev. Dans Cloudflare, ouvrez « Workers et Pages » une première fois " +
        "et choisissez le sous-domaine proposé (« Set up » / « Change » à côté de workers.dev), puis relancez « hubctl veille deploy ».",
    );
  }
  const workerUrl = `https://${WORKER_NAME}.${subdomain}.workers.dev`;

  // --- Base D1 ---
  log("2/7 Base D1 « kouzia-veille »...");
  const found = await ok<Array<{ uuid: string; name: string }>>("Recherche de la base D1", "GET", `${acct}/d1/database?name=${encodeURIComponent(D1_NAME)}`);
  let databaseId = found.find((d) => d.name === D1_NAME)?.uuid;
  if (!databaseId) {
    databaseId = (await ok<{ uuid: string }>("Création de la base D1", "POST", `${acct}/d1/database`, { name: D1_NAME })).uuid;
    log("   base créée");
  } else {
    log("   base existante réutilisée");
  }
  const statements = splitSql(input.schemaSql);
  for (const sql of statements) await ok("Schéma D1", "POST", `${acct}/d1/database/${databaseId}/query`, { sql });
  log(`   schéma appliqué (${statements.length} instructions)`);

  // --- Script ---
  log("3/7 Envoi du script...");
  const form = new FormData();
  form.append(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          main_module: "index.js",
          compatibility_date: COMPATIBILITY_DATE,
          bindings: [{ type: "d1", name: "DB", id: databaseId }],
          // Les secrets déjà posés restent en place pendant l'envoi ; ils sont reposés à l'étape suivante.
          keep_bindings: ["secret_text"],
        }),
      ],
      { type: "application/json" },
    ),
  );
  form.append("index.js", new Blob([input.script], { type: "application/javascript+module" }), "index.js");
  await ok("Envoi du script", "PUT", `${acct}/workers/scripts/${WORKER_NAME}`, undefined, { body: form });

  // --- Secrets ---
  log("4/7 Secrets du Worker...");
  const envUpdates: Record<string, string> = {};
  let shared = input.env.MONITOR_SHARED_SECRET?.trim() ?? "";
  if (shared.length < 32) {
    shared = deps.randomSecret();
    envUpdates.MONITOR_SHARED_SECRET = shared;
    log("   MONITOR_SHARED_SECRET créé (écrit dans le .env du hub)");
  }
  secrets.add(shared);
  const workerSecrets: Record<string, string> = { MONITOR_SHARED_SECRET: shared, ...(vapid as Record<string, string>) };
  for (const [name, text] of Object.entries(workerSecrets)) {
    await ok(`Secret ${name}`, "PUT", `${acct}/workers/scripts/${WORKER_NAME}/secrets`, { name, text, type: "secret_text" });
  }
  log(`   ${Object.keys(workerSecrets).length} secrets posés (valeurs jamais affichées)`);

  // --- Tâche planifiée et adresse ---
  log("5/7 Tâche planifiée chaque minute...");
  await ok("Tâche planifiée", "PUT", `${acct}/workers/scripts/${WORKER_NAME}/schedules`, [{ cron: CRON }]);
  log("6/7 Adresse workers.dev du script...");
  await ok("Adresse workers.dev", "POST", `${acct}/workers/scripts/${WORKER_NAME}/subdomain`, { enabled: true, previews_enabled: false });
  envUpdates.MONITOR_WORKER_URL = workerUrl;

  // --- Vérification : GET /state signé (l'adresse peut mettre quelques secondes à répondre) ---
  log(`7/7 Vérification de ${workerUrl}/state...`);
  for (let attempt = 1; ; attempt++) {
    const ts = String(Math.floor(deps.now() / 1000));
    const signature = await signRequest(shared, ts, "GET", "/state", "");
    let status = 0;
    let v: unknown = null;
    try {
      const res = await deps.fetch(`${workerUrl}/state`, { method: "GET", headers: { [TIMESTAMP_HEADER]: ts, [SIGNATURE_HEADER]: signature } });
      status = res.status;
      v = ((await res.json().catch(() => null)) as { v?: unknown } | null)?.v ?? null;
    } catch {
      status = 0;
    }
    if (status === 200 && v === PROTOCOL_VERSION) break;
    if (attempt >= 10) fail(`Le Worker ne répond pas comme attendu (dernier statut ${status || "aucun"}). Relancer « hubctl veille deploy » dans quelques minutes.`);
    await deps.sleep(3000);
  }
  log("   la veille répond.");
  return { workerUrl, databaseId, envUpdates };
}

// --- .env du hub (lecture et mise à jour en place : propriétaire et droits gardés) ---

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]!] = m[2]!.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  return out;
}

export function updateEnvText(text: string, updates: Record<string, string>): string {
  let out = text;
  for (const [key, value] of Object.entries(updates)) {
    if (/["\\$`\n]/.test(value)) throw new DeployError(`Valeur refusée pour ${key}.`);
    const line = `${key}="${value}"`;
    const re = new RegExp(`^${key}=.*$`, "m");
    out = re.test(out) ? out.replace(re, line) : `${out.replace(/\s*$/, "")}\n${line}\n`;
  }
  return out;
}
