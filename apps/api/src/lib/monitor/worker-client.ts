import {
  PROTOCOL_VERSION,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signRequest,
  type ReportBody,
  type StateResponse,
  type SyncBody,
} from "@/lib/monitor/core.js";

/** Client du Worker « kouzia-veille » : requêtes signées, en sortie seulement. */
export interface VeilleClient {
  readonly configured: boolean;
  sync(body: Omit<SyncBody, "v">): Promise<void>;
  report(body: Omit<ReportBody, "v">): Promise<void>;
  state(since: number): Promise<StateResponse>;
}

export class VeilleUnavailable extends Error {}

export class NoVeilleClient implements VeilleClient {
  readonly configured = false;
  async sync(): Promise<void> {}
  async report(): Promise<void> {}
  async state(): Promise<StateResponse> {
    throw new VeilleUnavailable("Worker de surveillance non configuré.");
  }
}

const MAX_STATE_BYTES = 5 * 1024 * 1024;

export class HttpVeilleClient implements VeilleClient {
  readonly configured = true;
  readonly #secret: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** Dernier horodatage signé par route : le Worker refuse un horodatage déjà vu ou plus ancien. */
  private readonly lastTimestamp = new Map<string, number>();

  constructor(options: { url: string; secret: string; fetch?: typeof fetch; now?: () => number }) {
    const url = new URL(options.url);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1") throw new Error("MONITOR_WORKER_URL doit être en https://");
    this.base = url.origin;
    this.#secret = options.secret;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async call(method: "GET" | "POST", pathname: string, query: string, body: string): Promise<Response> {
    // Strictement croissant par route (deux appels dans la même seconde) ; l'avance reste dans la
    // fenêtre de 5 min acceptée par le Worker.
    const route = `${method} ${pathname}`;
    const ts = Math.max(Math.floor(this.now() / 1000), (this.lastTimestamp.get(route) ?? 0) + 1);
    this.lastTimestamp.set(route, ts);
    const timestamp = String(ts);
    const signature = await signRequest(this.#secret, timestamp, method, `${pathname}${query}`, body);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${pathname}${query}`, {
        method,
        headers: {
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: signature,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new VeilleUnavailable("Worker de surveillance injoignable.");
    }
    if (!res.ok) throw new VeilleUnavailable(res.status === 404 ? "Worker de surveillance : signature refusée ou adresse inconnue." : `Worker de surveillance : statut ${res.status}.`);
    return res;
  }

  async sync(body: Omit<SyncBody, "v">): Promise<void> {
    const res = await this.call("POST", "/sync", "", JSON.stringify({ v: PROTOCOL_VERSION, ...body } satisfies SyncBody));
    await res.body?.cancel().catch(() => undefined);
  }

  async report(body: Omit<ReportBody, "v">): Promise<void> {
    const res = await this.call("POST", "/report", "", JSON.stringify({ v: PROTOCOL_VERSION, ...body } satisfies ReportBody));
    await res.body?.cancel().catch(() => undefined);
  }

  /** Signée sur le chemin et la requête (?since=), corps vide. */
  async state(since: number): Promise<StateResponse> {
    const res = await this.call("GET", "/state", `?since=${Math.max(0, Math.floor(since))}`, "");
    const text = await res.text();
    if (text.length > MAX_STATE_BYTES) throw new VeilleUnavailable("Worker de surveillance : réponse trop volumineuse.");
    let json: StateResponse;
    try {
      json = JSON.parse(text) as StateResponse;
    } catch {
      throw new VeilleUnavailable("Worker de surveillance : réponse illisible.");
    }
    if (json?.v !== PROTOCOL_VERSION || !Array.isArray(json.observations) || !Array.isArray(json.incidents) || (json.current !== undefined && !Array.isArray(json.current))) {
      throw new VeilleUnavailable("Worker de surveillance : version du protocole inattendue.");
    }
    return json;
  }
}

export function veilleFromEnv(): VeilleClient {
  const url = process.env.MONITOR_WORKER_URL?.trim();
  const secret = process.env.MONITOR_SHARED_SECRET?.trim();
  if (!url || !secret) return new NoVeilleClient();
  return new HttpVeilleClient({ url, secret });
}
