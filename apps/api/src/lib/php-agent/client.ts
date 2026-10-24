import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { z } from "zod";
import type { PhpAgentState } from "@/contract.js";

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
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: PhpAgentOptions) {
    if (options.secret.length < 32) throw new Error("PHP_AGENT_SECRET trop court (32 caractères au moins).");
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.#secret = options.secret;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.now = options.now ?? Date.now;
  }

  /** Requête signée ; réponse vérifiée (signature liée au nonce) avant d'être lue. */
  private async request(method: "GET" | "POST" | "PUT" | "DELETE", path: string, payload?: unknown, stream?: { file: string; sha256: string }): Promise<unknown> {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const timestamp = String(Math.floor(this.now() / 1000));
    const nonce = randomBytes(16).toString("hex");
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        method,
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
          ...(stream ? { "content-type": "application/gzip", "x-kouzia-hub-content-sha256": stream.sha256 } : {}),
          "x-kouzia-hub-timestamp": timestamp,
          "x-kouzia-hub-nonce": nonce,
          "x-kouzia-hub-signature": stream
            ? signAgentRequestHash(this.#secret, timestamp, nonce, method, path, stream.sha256)
            : signAgentRequest(this.#secret, timestamp, nonce, method, path, body),
        },
        ...(stream
          ? { body: Readable.toWeb(createReadStream(stream.file)) as unknown as RequestInit["body"], duplex: "half" }
          : body
            ? { body }
            : {}),
        signal: AbortSignal.timeout(stream ? 15 * 60_000 : this.timeoutMs),
      } as RequestInit);
    } catch {
      throw new PhpAgentUnavailableError();
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
    await this.request("POST", "/v1/sites", spec);
  }

  /** Envoie l'archive d'une version (flux, empreinte signée). */
  async sendVersion(slug: string, number: number, archive: { file: string; sha256: string }): Promise<void> {
    await this.request("PUT", `/v1/sites/${slug}/versions/${number}`, undefined, archive);
  }

  async publish(slug: string, number: number): Promise<void> {
    await this.request("POST", `/v1/sites/${slug}/publier`, { version: number });
  }

  async setEnabled(slug: string, enabled: boolean): Promise<void> {
    await this.request("POST", `/v1/sites/${slug}/${enabled ? "rallumer" : "couper"}`);
  }

  /** Contrôle anti-fuite : chaque chemin sensible doit répondre 403 ou 404 sur nginx local. */
  async check(slug: string): Promise<{ ok: boolean; results: Array<{ path: string; status: number }> }> {
    const parsed = z
      .object({ ok: z.boolean(), results: z.array(z.object({ path: z.string().max(300), status: z.number().int() })).max(50) })
      .safeParse(await this.request("GET", `/v1/sites/${slug}/verifier`));
    if (!parsed.success) throw new PhpAgentUnavailableError("Serveur des sites PHP : contrôle illisible.");
    return parsed.data;
  }

  async removeSite(slug: string): Promise<void> {
    await this.request("DELETE", `/v1/sites/${slug}`);
  }
}

/** Réglages d'un site PHP envoyés à l'agent (validés de nouveau par lui). */
export type PhpSiteSpec = { slug: string; hostname: string; php: string; publicDir: string; persistentDirs: string[]; indexing: boolean };

/** Client si PHP_AGENT_URL est posée (secret obligatoire), sinon null : la fonction PHP n'est pas encore installée. */
export function phpAgentFromEnv(env: NodeJS.ProcessEnv = process.env): PhpAgentClient | null {
  const baseUrl = env.PHP_AGENT_URL?.trim();
  if (!baseUrl) return null;
  const secret = env.PHP_AGENT_SECRET?.trim();
  if (!secret) throw new Error("PHP_AGENT_URL posée sans PHP_AGENT_SECRET : secret partagé avec l'agent requis.");
  if (!/^http:\/\/[0-9.]+:\d+$/.test(baseUrl)) throw new Error("PHP_AGENT_URL attendue sous la forme http://<IP du CT PHP>:8790.");
  return new PhpAgentClient({ baseUrl, secret });
}
