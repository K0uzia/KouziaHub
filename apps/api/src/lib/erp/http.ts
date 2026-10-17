import { createHmac } from "node:crypto";
import { z } from "zod";
import { ERP_CLIENT_ID, ErpUnavailableError, filterClients, type ErpClient, type ErpDirectory } from "@/lib/erp/types.js";

export type HttpErpOptions = {
  baseUrl: string;
  secret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  cacheMs?: number;
  now?: () => number;
};

const clientSchema = z.object({
  id: z.string().regex(ERP_CLIENT_ID),
  clientNumber: z.string().max(64).nullable(),
  displayName: z.string().min(1).max(300),
  type: z.enum(["B2B", "B2C", "ASSOCIATION"]),
});
const listSchema = z.object({ clients: z.array(clientSchema).max(10_000) });
const oneSchema = z.object({ client: clientSchema });

export const ERP_LIST_PATH = "/api/hub/clients";

/** Signature d'une requête vers l'ERP : HMAC-SHA256 hexadécimal de « horodatage.MÉTHODE.chemin ». */
export function signErpRequest(secret: string, timestamp: string, method: string, pathname: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${method.toUpperCase()}.${pathname}`).digest("hex")}`;
}

/**
 * Annuaire HTTP de l'ERP (réseau local du Proxmox, hors tunnel). Liste complète en cache mémoire
 * quelques minutes, filtrée sur place : le filtre ne part pas dans l'URL et la signature reste simple.
 */
export class HttpErpDirectory implements ErpDirectory {
  readonly mode = "http" as const;
  readonly #secret: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private readonly now: () => number;
  private cache: { at: number; clients: ErpClient[] } | null = null;
  private inflight: Promise<ErpClient[]> | null = null;

  constructor(options: HttpErpOptions) {
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.#secret = options.secret;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.cacheMs = options.cacheMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  private async request(pathname: string): Promise<Response> {
    const timestamp = String(Math.floor(this.now() / 1000));
    try {
      return await this.fetchImpl(this.base + pathname, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "x-kouzia-hub-timestamp": timestamp,
          "x-kouzia-hub-signature": signErpRequest(this.#secret, timestamp, "GET", pathname),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ErpUnavailableError();
    }
  }

  private async loadAll(): Promise<ErpClient[]> {
    if (this.cache && this.now() - this.cache.at < this.cacheMs) return this.cache.clients;
    this.inflight ??= (async () => {
      try {
        const res = await this.request(ERP_LIST_PATH);
        if (!res.ok) throw new ErpUnavailableError();
        const parsed = listSchema.safeParse(await res.json().catch(() => null));
        if (!parsed.success) throw new ErpUnavailableError("Réponse de l'ERP illisible.");
        this.cache = { at: this.now(), clients: parsed.data.clients };
        return parsed.data.clients;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  async list(q?: string): Promise<ErpClient[]> {
    return filterClients(await this.loadAll(), q);
  }

  async get(id: string): Promise<ErpClient | null> {
    if (!ERP_CLIENT_ID.test(id)) return null;
    const cached = this.cache && this.now() - this.cache.at < this.cacheMs ? this.cache.clients.find((c) => c.id === id) : undefined;
    if (cached) return cached;
    const res = await this.request(`${ERP_LIST_PATH}/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new ErpUnavailableError();
    const parsed = oneSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new ErpUnavailableError("Réponse de l'ERP illisible.");
    return parsed.data.client;
  }
}
