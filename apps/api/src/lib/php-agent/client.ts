import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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

const sha256Hex = (body: string) => createHash("sha256").update(body).digest("hex");

export function signAgentRequest(secret: string, timestamp: string, nonce: string, method: string, path: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${nonce}.${method.toUpperCase()}.${path}.${sha256Hex(body)}`).digest("hex")}`;
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
  private async request(method: "GET" | "POST", path: string, payload?: unknown): Promise<unknown> {
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
          "x-kouzia-hub-timestamp": timestamp,
          "x-kouzia-hub-nonce": nonce,
          "x-kouzia-hub-signature": signAgentRequest(this.#secret, timestamp, nonce, method, path, body),
        },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
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
    if (!res.ok) throw new PhpAgentUnavailableError(`Serveur des sites PHP : opération refusée (${res.status}).`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new PhpAgentUnavailableError("Serveur des sites PHP : réponse illisible.");
    }
  }

  async state(): Promise<PhpAgentState> {
    const parsed = stateSchema.safeParse(await this.request("GET", "/v1/etat"));
    if (!parsed.success) throw new PhpAgentUnavailableError("Serveur des sites PHP : état illisible (versions de l'agent et du hub différentes ?).");
    return parsed.data;
  }
}

/** Client si PHP_AGENT_URL est posée (secret obligatoire), sinon null : la fonction PHP n'est pas encore installée. */
export function phpAgentFromEnv(env: NodeJS.ProcessEnv = process.env): PhpAgentClient | null {
  const baseUrl = env.PHP_AGENT_URL?.trim();
  if (!baseUrl) return null;
  const secret = env.PHP_AGENT_SECRET?.trim();
  if (!secret) throw new Error("PHP_AGENT_URL posée sans PHP_AGENT_SECRET : secret partagé avec l'agent requis.");
  if (!/^http:\/\/[0-9.]+:\d+$/.test(baseUrl)) throw new Error("PHP_AGENT_URL attendue sous la forme http://<IP du CT PHP>:8790.");
  return new PhpAgentClient({ baseUrl, secret });
}
