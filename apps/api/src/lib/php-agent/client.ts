import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { failureText, fetchSend, httpSend, type Send } from "@/lib/php-agent/transport.js";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { z } from "zod";
import type { PhpAgentState, PhpCronView, PhpLogKind, PhpLogView } from "@/contract.js";

// Client de l'agent du CT des sites PHP (docs/cadrage.md, section 11.1 ; agent : scripts/php-ct/agent/agent.mjs).
// Même protocole des deux côtés, comparé par un test : requête signée (horodatage, nonce, méthode, chemin,
// empreinte du corps), réponse signée et liée au nonce. Réseau du Proxmox seulement, jamais par un tunnel.

export class PhpAgentUnavailableError extends Error {
  constructor(message = "Serveur des sites PHP injoignable.") {
    super(message);
    this.name = "PhpAgentUnavailableError";
  }
}

/** Refus d'une opération par l'agent (réglage invalide, site ou version absents...) : message de l'agent, statut. */
export class PhpAgentOpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PhpAgentOpError";
  }
}

// Délais : lecture d'état 5 s (défaut) ; opération sur un site (services relancés, nginx rechargé) 60 s ;
// contrôle anti-fuite 30 s (l'agent borne chaque sonde de nginx à 2 s).
const OPERATION_TIMEOUT_MS = 60_000;
const CHECK_TIMEOUT_MS = 30_000;
// Lot P4 : dump et restauration d'une base (30 min côté agent), script du projet (120 s côté agent).
const DUMP_TIMEOUT_MS = 31 * 60_000;
// Envois en flux : version (archive lourde, puis contrôle et extraction sur le CT), mise à jour du CT (install.sh,
// 20 min au plus côté agent).
const VERSION_TIMEOUT_MS = 30 * 60_000;
const CT_UPDATE_TIMEOUT_MS = 25 * 60_000;
const SCRIPT_TIMEOUT_MS = 150_000;

const sha256Hex = (body: string) => createHash("sha256").update(body).digest("hex");

export function signAgentRequest(secret: string, timestamp: string, nonce: string, method: string, path: string, body: string): string {
  return signAgentRequestHash(secret, timestamp, nonce, method, path, sha256Hex(body));
}

/** Même signature, sur l'empreinte d'un corps envoyé en flux (archive d'une version). */
export function signAgentRequestHash(secret: string, timestamp: string, nonce: string, method: string, path: string, bodySha256: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${nonce}.${method.toUpperCase()}.${path}.${bodySha256}`).digest("hex")}`;
}

export function signAgentResponse(secret: string, nonce: string, status: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${nonce}.${status}.${sha256Hex(body)}`).digest("hex")}`;
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const serviceState = z.enum(["running", "stopped", "absent"]);
const stateSchema = z.object({
  agentVersion: z.string().max(20),
  alpine: z.string().max(40).nullable(),
  node: z.string().max(40),
  php: z.array(z.string().regex(/^\d\.\d$/)).max(10),
  services: z.object({ nginx: serviceState, mariadb: serviceState, tunnel: serviceState, firewall: serviceState }),
  cgroups: z.object({ result: z.enum(["ok", "echec"]).nullable(), checkedAt: z.string().max(40).nullable() }),
  lastUpgrade: z.string().max(40).nullable(),
  disk: z.object({ freeBytes: z.number().nonnegative(), totalBytes: z.number().nonnegative() }).nullable(),
  // Ajoutée avec le lot P4 : absente d'un agent plus ancien.
  memoryBytes: z.number().nonnegative().nullable().default(null),
  // Ajoutés avec la mise à jour par le hub (agent 2) : absents d'un agent plus ancien.
  scripts: z
    .object({ digest: z.string().regex(/^[0-9a-f]{64}$/).nullable(), installedAt: z.string().max(40).nullable(), result: z.enum(["ok", "echec"]).nullable() })
    .nullable()
    .default(null),
  sites: z.number().int().nonnegative(),
  time: z.string().max(40),
});

export type PhpAgentOptions = {
  baseUrl: string;
  secret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
};

export class PhpAgentClient {
  readonly #secret: string;
  private readonly base: string;
  private readonly send: Send;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: PhpAgentOptions) {
    if (options.secret.length < 32) throw new Error("PHP_AGENT_SECRET trop court (32 caractères au moins).");
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.#secret = options.secret;
    // Par défaut node:http (sans délai caché) ; un fetch injecté sert aux tests de réponses forgées.
    this.send = options.fetch ? fetchSend(options.fetch) : httpSend;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.now = options.now ?? Date.now;
  }

  /** Requête signée ; réponse vérifiée (signature liée au nonce) avant d'être lue. */
  private async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    payload?: unknown,
    stream?: { file: string; sha256: string },
    timeoutMs = this.timeoutMs,
  ): Promise<unknown> {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const timestamp = String(Math.floor(this.now() / 1000));
    const nonce = randomBytes(16).toString("hex");
    let res: Response;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      res = await this.send(this.base + path, {
        method,
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
          // Taille annoncée : l'agent refuse (413) une archive trop lourde avant de la recevoir.
          ...(stream ? { "content-type": "application/gzip", "content-length": String((await stat(stream.file)).size), "x-kouzia-hub-content-sha256": stream.sha256 } : {}),
          "x-kouzia-hub-timestamp": timestamp,
          "x-kouzia-hub-nonce": nonce,
          "x-kouzia-hub-signature": stream
            ? signAgentRequestHash(this.#secret, timestamp, nonce, method, path, stream.sha256)
            : signAgentRequest(this.#secret, timestamp, nonce, method, path, body),
        },
        body: stream ? createReadStream(stream.file) : body || undefined,
        signal,
      });
    } catch (err) {
      // Délai dépassé, refus, réseau ou coupure : chaque cause dite telle quelle (pas tout en « injoignable »).
      throw new PhpAgentUnavailableError(failureText(err, signal.aborted, timeoutMs, `${method} ${path}`));
    }
    const text = await res.text().catch(() => "");
    if (res.status === 401) throw new PhpAgentUnavailableError("Serveur des sites PHP : signature refusée (secret différent des deux côtés, ou horloges décalées).");
    if (res.status === 403) throw new PhpAgentUnavailableError("Serveur des sites PHP : l'adresse du hub n'est pas autorisée par l'agent.");
    const signature = res.headers.get("x-kouzia-agent-signature") ?? "";
    if (!sameText(signature, signAgentResponse(this.#secret, nonce, res.status, text))) {
      throw new PhpAgentUnavailableError("Serveur des sites PHP : réponse non signée, ignorée.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new PhpAgentUnavailableError("Serveur des sites PHP : réponse illisible.");
    }
    if (!res.ok) {
      const message = typeof (parsed as { error?: unknown })?.error === "string" ? (parsed as { error: string }).error : `opération refusée (${res.status})`;
      throw new PhpAgentOpError(res.status, `Serveur des sites PHP : ${message}`);
    }
    return parsed;
  }

  async state(): Promise<PhpAgentState> {
    const parsed = stateSchema.safeParse(await this.request("GET", "/v1/etat"));
    if (!parsed.success) throw new PhpAgentUnavailableError("Serveur des sites PHP : état illisible (versions de l'agent et du hub différentes ?).");
    return parsed.data;
  }

  /** Identifiant du tunnel du CT PHP : cible des CNAME des sites (<id>.cfargotunnel.com), null si absent. */
  async tunnelId(): Promise<string | null> {
    const parsed = z.object({ tunnelId: z.string().uuid().nullable() }).safeParse(await this.request("GET", "/v1/tunnel"));
    if (!parsed.success) throw new PhpAgentUnavailableError("Serveur des sites PHP : identifiant du tunnel illisible.");
    return parsed.data.tunnelId;
  }

  /** Crée ou met à jour le site sur le CT (rejouable). */
  async upsertSite(spec: PhpSiteSpec): Promise<void> {
    await this.request("POST", "/v1/sites", spec, undefined, OPERATION_TIMEOUT_MS);
  }

  /** Envoie l'archive d'une version (flux, empreinte signée). */
  async sendVersion(slug: string, number: number, archive: { file: string; sha256: string }): Promise<void> {
    await this.request("PUT", `/v1/sites/${slug}/versions/${number}`, undefined, archive, VERSION_TIMEOUT_MS);
  }

  async publish(slug: string, number: number): Promise<void> {
    await this.request("POST", `/v1/sites/${slug}/publier`, { version: number }, undefined, OPERATION_TIMEOUT_MS);
  }

  async setEnabled(slug: string, enabled: boolean): Promise<void> {
    await this.request("POST", `/v1/sites/${slug}/${enabled ? "rallumer" : "couper"}`, undefined, undefined, OPERATION_TIMEOUT_MS);
  }

  /** Contrôle anti-fuite : chaque chemin sensible doit répondre 403 ou 404 sur nginx local. */
  async check(slug: string): Promise<{ ok: boolean; results: Array<{ path: string; status: number }> }> {
    const parsed = z
      .object({ ok: z.boolean(), results: z.array(z.object({ path: z.string().max(300), status: z.number().int() })).max(50) })
      .safeParse(await this.request("GET", `/v1/sites/${slug}/verifier`, undefined, undefined, CHECK_TIMEOUT_MS));
    if (!parsed.success) throw new PhpAgentUnavailableError("Serveur des sites PHP : contrôle illisible.");
    return parsed.data;
  }

  async removeSite(slug: string): Promise<void> {
    await this.request("DELETE", `/v1/sites/${slug}`, undefined, undefined, OPERATION_TIMEOUT_MS);
  }

  /** Scripts du CT (archive du dépôt du hub, envoyée en flux) : installés par l'agent, qui se relance ensuite. */
  async updateScripts(digest: string, archive: { file: string; sha256: string }): Promise<{ ok: boolean; log: string }> {
    const parsed = z
      .object({ ok: z.boolean(), digest: z.string(), log: z.string().max(300_000) })
      .safeParse(await this.request("PUT", `/v1/ct/scripts/${digest}`, undefined, archive, CT_UPDATE_TIMEOUT_MS));
    if (!parsed.success || parsed.data.digest !== digest) throw new PhpAgentUnavailableError("Serveur des sites PHP : réponse de la mise à jour illisible.");
    return { ok: parsed.data.ok, log: parsed.data.log };
  }

  // --- Lot P5 : tâche planifiée, journaux ---

  async cronState(slug: string): Promise<PhpCronView> {
    const parsed = cronSchema.safeParse(await this.request("GET", `/v1/sites/${slug}/cron`, undefined, undefined, OPERATION_TIMEOUT_MS));
    if (!parsed.success) throw new PhpAgentUnavailableError("Serveur des sites PHP : état de la tâche planifiée illisible.");
    return parsed.data;
  }

  async logs(slug: string, kind: PhpLogKind, lines: number): Promise<PhpLogView> {
    const parsed = z.object({ kind: z.enum(["php", "fpm", "nginx", "cron"]), text: z.string().max(600_000) }).safeParse(
      await this.request("GET", `/v1/sites/${slug}/journaux/${kind}/${lines}`, undefined, undefined, OPERATION_TIMEOUT_MS),
    );
    if (!parsed.success) throw new PhpAgentUnavailableError("Serveur des sites PHP : journal illisible.");
    return parsed.data;
  }

  // --- Lot P4 : variables, base, script du projet ---

  /** Variables saisies (jamais les DB_*, remplies par l'agent) : réécrit le .env du site. */
  async setEnv(slug: string, vars: Record<string, string>): Promise<void> {
    await this.request("PUT", `/v1/sites/${slug}/env`, { vars }, undefined, OPERATION_TIMEOUT_MS);
  }

  async dbState(slug: string): Promise<PhpDbState> {
    return parseDbState(await this.request("GET", `/v1/sites/${slug}/base`, undefined, undefined, OPERATION_TIMEOUT_MS));
  }

  async createDb(slug: string): Promise<PhpDbState> {
    return parseDbState(await this.request("POST", `/v1/sites/${slug}/base`, undefined, undefined, OPERATION_TIMEOUT_MS));
  }

  async resetDb(slug: string): Promise<PhpDbState> {
    return parseDbState(await this.request("POST", `/v1/sites/${slug}/base/reinitialiser`, undefined, undefined, OPERATION_TIMEOUT_MS));
  }

  /** Import d'un fichier SQL (.sql, ou .sql.gz si gz), envoyé en flux. */
  async importDb(slug: string, file: { file: string; sha256: string }, gz: boolean): Promise<PhpDbState> {
    return parseDbState(await this.request("PUT", `/v1/sites/${slug}/base/import/${gz ? "sqlgz" : "sql"}`, undefined, file, DUMP_TIMEOUT_MS));
  }

  /** Dump avant publication de la version n (rien sans base). */
  async dumpBefore(slug: string, version: number): Promise<{ dumped: boolean }> {
    const parsed = z.object({ dumped: z.boolean() }).safeParse(await this.request("POST", `/v1/sites/${slug}/base/dump`, { version }, undefined, DUMP_TIMEOUT_MS));
    if (!parsed.success) throw new PhpAgentUnavailableError("Serveur des sites PHP : réponse du dump illisible.");
    return parsed.data;
  }

  async restoreDump(slug: string, version: number): Promise<PhpDbState> {
    return parseDbState(await this.request("POST", `/v1/sites/${slug}/base/restaurer`, { version }, undefined, DUMP_TIMEOUT_MS));
  }

  /** Lance un script du projet ; l'entrée standard (un mot de passe, par exemple) n'est jamais journalisée. */
  async runScript(slug: string, path: string, args: string[], stdin: string): Promise<PhpScriptResult> {
    const parsed = scriptSchema.safeParse(await this.request("POST", `/v1/sites/${slug}/script`, { path, args, stdin }, undefined, SCRIPT_TIMEOUT_MS));
    if (!parsed.success) throw new PhpAgentUnavailableError("Serveur des sites PHP : résultat du script illisible.");
    return parsed.data;
  }

  /**
   * Export de la base (.sql.gz) écrit dans « file » : empreinte annoncée par l'agent, signée avec le nonce de la
   * requête, recalculée ici. Fichier retiré si elle diffère.
   */
  async exportDb(slug: string, file: string): Promise<{ sha256: string; size: number }> {
    return this.download(`/v1/sites/${slug}/base/export`, file, DUMP_TIMEOUT_MS, "export");
  }

  /** E-mail capturé (.eml) écrit dans « file », même contrôle d'empreinte signée que l'export. */
  async downloadMail(slug: string, id: string, file: string): Promise<{ sha256: string; size: number }> {
    return this.download(`/v1/sites/${slug}/mails/${id}`, file, OPERATION_TIMEOUT_MS, "e-mail");
  }

  async mails(slug: string): Promise<PhpAgentMail[]> {
    const parsed = mailsSchema.safeParse(await this.request("GET", `/v1/sites/${slug}/mails`, undefined, undefined, OPERATION_TIMEOUT_MS));
    if (!parsed.success) throw new PhpAgentUnavailableError("Serveur des sites PHP : liste des e-mails illisible.");
    return parsed.data.mails;
  }

  async removeMail(slug: string, id: string): Promise<void> {
    await this.request("DELETE", `/v1/sites/${slug}/mails/${id}`, undefined, undefined, OPERATION_TIMEOUT_MS);
  }

  async clearMails(slug: string): Promise<number> {
    const r = (await this.request("DELETE", `/v1/sites/${slug}/mails`, undefined, undefined, OPERATION_TIMEOUT_MS)) as { removed?: unknown };
    return typeof r.removed === "number" ? r.removed : 0;
  }

  private async download(path: string, file: string, timeoutMs: number, what: string): Promise<{ sha256: string; size: number }> {
    const timestamp = String(Math.floor(this.now() / 1000));
    const nonce = randomBytes(16).toString("hex");
    let res: Response;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      res = await this.send(this.base + path, {
        method: "GET",
        headers: {
          "x-kouzia-hub-timestamp": timestamp,
          "x-kouzia-hub-nonce": nonce,
          "x-kouzia-hub-signature": signAgentRequest(this.#secret, timestamp, nonce, "GET", path, ""),
        },
        body: undefined,
        signal,
      });
    } catch (err) {
      throw new PhpAgentUnavailableError(failureText(err, signal.aborted, timeoutMs, `GET ${path}`));
    }
    if (res.status !== 200 || !res.body) {
      // Refus : réponse JSON signée ordinaire.
      const text = await res.text().catch(() => "");
      if (!sameText(res.headers.get("x-kouzia-agent-signature") ?? "", signAgentResponse(this.#secret, nonce, res.status, text))) {
        throw new PhpAgentUnavailableError("Serveur des sites PHP : réponse non signée, ignorée.");
      }
      let message = `opération refusée (${res.status})`;
      try {
        const e = (JSON.parse(text) as { error?: unknown }).error;
        if (typeof e === "string") message = e;
      } catch {
        // Corps illisible : message générique.
      }
      throw new PhpAgentOpError(res.status, `Serveur des sites PHP : ${message}`);
    }
    const declared = res.headers.get("x-kouzia-agent-content-sha256") ?? "";
    if (!/^[0-9a-f]{64}$/.test(declared) || !sameText(res.headers.get("x-kouzia-agent-signature") ?? "", signAgentResponseHash(this.#secret, nonce, 200, declared))) {
      await res.body.cancel().catch(() => undefined);
      throw new PhpAgentUnavailableError(`Serveur des sites PHP : ${what} non signé, ignoré.`);
    }
    const hash = createHash("sha256");
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk);
        size += chunk.length;
        done(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), counter, createWriteStream(file, { mode: 0o600 }));
    } catch {
      await rm(file, { force: true });
      throw new PhpAgentUnavailableError(`Serveur des sites PHP : ${what} interrompu.`);
    }
    const sha256 = hash.digest("hex");
    if (sha256 !== declared) {
      await rm(file, { force: true });
      throw new PhpAgentUnavailableError(`Serveur des sites PHP : ${what} altéré en route (empreinte différente).`);
    }
    return { sha256, size };
  }
}

const mailsSchema = z.object({
  mails: z
    .array(
      z.object({
        id: z.string().regex(/^[0-9]{13}-[0-9a-f]{8}$/),
        receivedAt: z.string().max(40),
        size: z.number().int().nonnegative(),
        envelopeFrom: z.string().max(320),
        envelopeTo: z.array(z.string().max(320)).max(100),
        subject: z.string().max(1000).nullable(),
        from: z.string().max(1000).nullable(),
        to: z.string().max(1000).nullable(),
        date: z.string().max(1000).nullable(),
        attachments: z.number().int().nonnegative(),
      }),
    )
    .max(1000),
});
export type PhpAgentMail = z.infer<typeof mailsSchema>["mails"][number];

const cronSchema = z.object({
  cron: z.object({ script: z.string().max(200), every: z.enum(["5m", "15m", "30m", "1h", "1d"]) }).nullable(),
  active: z.boolean(),
  maxSec: z.number().int().nullable(),
  last: z
    .object({ start: z.string().max(40), durationSec: z.number().nonnegative(), code: z.number().int().nullable(), timedOut: z.boolean(), skipped: z.boolean() })
    .nullable(),
  output: z.string().max(600_000),
});

export type PhpDbState = { exists: boolean; name: string | null; bytes: number; tables: number; dumps: number[] };
export type PhpScriptResult = { script: string; code: number; timedOut: boolean; durationMs: number; output: string };

const dbStateSchema = z.object({
  exists: z.boolean(),
  name: z.string().max(64).nullable(),
  bytes: z.number().nonnegative(),
  tables: z.number().int().nonnegative(),
  dumps: z.array(z.number().int().positive()).max(50),
});
const scriptSchema = z.object({
  script: z.string().max(200),
  code: z.number().int(),
  timedOut: z.boolean(),
  durationMs: z.number().nonnegative(),
  output: z.string().max(70_000),
});

function parseDbState(raw: unknown): PhpDbState {
  const parsed = dbStateSchema.safeParse(raw);
  if (!parsed.success) throw new PhpAgentUnavailableError("Serveur des sites PHP : état de la base illisible.");
  return parsed.data;
}

export function signAgentResponseHash(secret: string, nonce: string, status: number, bodySha256: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${nonce}.${status}.${bodySha256}`).digest("hex")}`;
}

/** Réglages d'un site PHP envoyés à l'agent (validés de nouveau par lui). */
export type PhpSiteSpec = {
  slug: string;
  hostname: string;
  php: string;
  publicDir: string;
  persistentDirs: string[];
  publicPersistentDirs: string[];
  memoryLimitMb: number;
  uploadMaxMb: number;
  maxExecutionSec: number;
  cron: { script: string; every: string } | null;
  indexing: boolean;
};

/** Client si PHP_AGENT_URL est posée (secret obligatoire), sinon null : la fonction PHP n'est pas encore installée. */
export function phpAgentFromEnv(env: NodeJS.ProcessEnv = process.env): PhpAgentClient | null {
  const baseUrl = env.PHP_AGENT_URL?.trim();
  if (!baseUrl) return null;
  const secret = env.PHP_AGENT_SECRET?.trim();
  if (!secret) throw new Error("PHP_AGENT_URL posée sans PHP_AGENT_SECRET : secret partagé avec l'agent requis.");
  if (!/^http:\/\/[0-9.]+:\d+$/.test(baseUrl)) throw new Error("PHP_AGENT_URL attendue sous la forme http://<IP du CT PHP>:8790.");
  return new PhpAgentClient({ baseUrl, secret });
}
