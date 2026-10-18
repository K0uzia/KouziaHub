import { CloudflareError } from "@/lib/cloudflare/types.js";

/**
 * Zones du compte Cloudflare, lues avec un jeton SÉPARÉ en lecture seule (Zone > Zone > Read),
 * CLOUDFLARE_ZONES_READ_TOKEN. Sert seulement à proposer des cibles de surveillance.
 */
export interface ZonesDirectory {
  readonly configured: boolean;
  listZones(): Promise<string[]>;
}

export class NoZonesDirectory implements ZonesDirectory {
  readonly configured = false;
  async listZones(): Promise<string[]> {
    return [];
  }
}

export class FakeZonesDirectory implements ZonesDirectory {
  readonly configured = true;
  constructor(private readonly zones: string[] = []) {}
  async listZones(): Promise<string[]> {
    return [...this.zones].sort();
  }
}

const PER_PAGE = 50;

export class RealZonesDirectory implements ZonesDirectory {
  readonly configured = true;
  readonly #token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;

  constructor(options: { token: string; fetch?: typeof fetch; baseUrl?: string }) {
    this.#token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.base = (options.baseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
  }

  /** GET /zones paginé (50 par page) ; le jeton n'apparaît dans aucun message. */
  async listZones(): Promise<string[]> {
    const names: string[] = [];
    for (let page = 1; page <= 100; page++) {
      const url = `${this.base}/zones?per_page=${PER_PAGE}&page=${page}`;
      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.#token}` }, signal: AbortSignal.timeout(15_000) });
      } catch {
        throw new CloudflareError("Cloudflare injoignable (zones).", null);
      }
      const body = (await res.json().catch(() => null)) as {
        success?: boolean;
        result?: Array<{ name?: string }>;
        result_info?: { total_pages?: number };
      } | null;
      if (!res.ok || !body || body.success === false) {
        throw new CloudflareError(
          res.status === 401 || res.status === 403
            ? "Cloudflare refuse le jeton de lecture des zones (invalide, expiré ou sans le droit Zone Read)."
            : "Lecture des zones Cloudflare impossible.",
          res.status,
        );
      }
      const batch = body.result ?? [];
      for (const z of batch) if (typeof z.name === "string") names.push(z.name.toLowerCase());
      const total = body.result_info?.total_pages ?? 1;
      if (batch.length < PER_PAGE || page >= total) break;
    }
    return names.sort();
  }
}

export function zonesFromEnv(): ZonesDirectory {
  const token = process.env.CLOUDFLARE_ZONES_READ_TOKEN?.trim();
  return token ? new RealZonesDirectory({ token }) : new NoZonesDirectory();
}
