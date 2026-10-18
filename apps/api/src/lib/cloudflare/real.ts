import { contentTypeOf } from "@/lib/mime.js";
import { pagesAssetHash } from "@/lib/cloudflare/hash.js";
import {
  CloudflareError,
  HUB_DNS_COMMENT_PREFIX,
  type CfDeployment,
  type CfDeploymentInfo,
  type CfDnsRecord,
  type CfDomain,
  type CfProject,
  type CloudflareGateway,
  isFailClosed,
  type DeployInput,
} from "@/lib/cloudflare/types.js";

export type RealCloudflareOptions = {
  token: string;
  accountId: string;
  zoneId: string;
  /** Injecté dans les tests (faux serveur en mémoire) : aucun appel réseau réel. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Tentatives au total sur 429, 5xx ou erreur réseau. Défaut 3. */
  maxAttempts?: number;
  baseUrl?: string;
};

type CfEnvelope<T> = {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
  result_info?: { page?: number; per_page?: number; total_pages?: number; count?: number; total_count?: number };
};

type CallOptions = {
  json?: unknown;
  form?: FormData;
  query?: Record<string, string>;
  /** Jeton d'envoi (JWT) des appels /pages/assets à la place du jeton API. */
  bearer?: string;
};

/** Lots d'envoi des fichiers, comme wrangler : 40 Mio de contenu brut ou 2 000 fichiers au plus par appel. */
const BUCKET_BYTES = 40 * 1024 * 1024;
const BUCKET_FILES = 2000;
const PROJECTS_PAGE = 10;
const DNS_PAGE = 100;

/**
 * Adaptateur réel : API HTTP de Cloudflare (Pages et DNS), écrit d'après la documentation. Le jeton ne
 * sort jamais de ce module : ni journalisé, ni renvoyé, ni recopié dans un message d'erreur.
 */
/** Pages Functions en « fail closed » (production et aperçus) : voir createProject. */
const FAIL_CLOSED = { production: { fail_open: false }, preview: { fail_open: false } };

type RawProject = { name?: string; subdomain?: string; deployment_configs?: { production?: { fail_open?: unknown }; preview?: { fail_open?: unknown } } };

export class RealCloudflare implements CloudflareGateway {
  readonly mode = "real" as const;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxAttempts: number;
  readonly #base: string;
  readonly #account: string;
  readonly #zone: string;

  constructor(options: RealCloudflareOptions) {
    if (!options.token || !options.accountId || !options.zoneId) {
      throw new Error("Cloudflare : CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID et CLOUDFLARE_ZONE_ID sont requis ensemble.");
    }
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.#base = (options.baseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
    this.#account = encodeURIComponent(options.accountId);
    this.#zone = encodeURIComponent(options.zoneId);
  }

  private projectPath(name: string): string {
    return `/accounts/${this.#account}/pages/projects/${encodeURIComponent(name)}`;
  }

  private scrub(text: string, extra?: string): string {
    let out = text.split(this.#token).join("[masqué]");
    if (extra) out = out.split(extra).join("[masqué]");
    return out.slice(0, 200);
  }

  private translate(status: number, envelope: CfEnvelope<unknown> | null, bearer?: string): CloudflareError {
    const first = envelope?.errors?.[0];
    const code = typeof first?.code === "number" ? first.code : null;
    const detail = first?.message ? ` (code ${code ?? "?"} : ${this.scrub(first.message, bearer)})` : code ? ` (code ${code})` : "";
    let message: string;
    if (status === 401 || status === 403) message = "Cloudflare refuse l'accès : jeton invalide, expiré ou sans les droits nécessaires";
    else if (status === 404) message = "Élément introuvable chez Cloudflare";
    else if (status === 429) message = "Cloudflare limite le nombre de demandes : réessayez dans quelques minutes";
    else if (status >= 500) message = "Cloudflare est indisponible pour le moment : réessayez plus tard";
    else message = "Cloudflare a refusé la demande";
    return new CloudflareError(`${message}${detail}.`, status, code);
  }

  private async call<T>(method: string, path: string, options: CallOptions = {}): Promise<CfEnvelope<T>> {
    const url = new URL(this.#base + path);
    for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Authorization: `Bearer ${options.bearer ?? this.#token}` };
    let body: string | FormData | undefined;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    } else if (options.form) {
      body = options.form;
    }

    let lastError: CloudflareError | null = null;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await this.#fetch(url, { method, headers, body, signal: AbortSignal.timeout(120_000) });
      } catch {
        lastError = new CloudflareError("Cloudflare injoignable (réseau ou délai dépassé).", null);
        if (attempt < this.#maxAttempts) await this.#sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      let envelope: CfEnvelope<T> | null = null;
      try {
        envelope = (await res.json()) as CfEnvelope<T>;
      } catch {
        envelope = null;
      }
      if (res.ok && envelope && envelope.success !== false) return envelope;
      const error = this.translate(res.status, envelope, options.bearer);
      if ((res.status === 429 || res.status >= 500) && attempt < this.#maxAttempts) {
        lastError = error;
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.#sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 500 * 2 ** (attempt - 1));
        continue;
      }
      if (res.ok && !envelope) throw new CloudflareError("Réponse illisible de Cloudflare.", res.status);
      throw error;
    }
    throw lastError ?? new CloudflareError("Cloudflare injoignable.", null);
  }

  private async orNull<T>(promise: Promise<T>): Promise<T | null> {
    try {
      return await promise;
    } catch (err) {
      if (err instanceof CloudflareError && err.status === 404) return null;
      throw err;
    }
  }

  private toProject(raw: RawProject | undefined, fallbackName: string): CfProject {
    const name = raw?.name ?? fallbackName;
    const project: CfProject = { name, subdomain: raw?.subdomain ?? `${name}.pages.dev` };
    const configs = raw?.deployment_configs;
    if (configs) {
      const flag = (v: unknown) => (typeof v === "boolean" ? v : null);
      project.failOpen = { production: flag(configs.production?.fail_open), preview: flag(configs.preview?.fail_open) };
    }
    return project;
  }

  async getProject(name: string): Promise<CfProject | null> {
    const env = await this.orNull(this.call<RawProject>("GET", this.projectPath(name)));
    return env ? this.toProject(env.result, name) : null;
  }

  async setFailClosed(name: string): Promise<void> {
    await this.call("PATCH", this.projectPath(name), { json: { deployment_configs: FAIL_CLOSED } });
  }

  /**
   * Projet créé en « fail closed » : quand le quota gratuit de Pages Functions est épuisé, Cloudflare renvoie
   * une erreur au lieu de servir les fichiers sans le _worker.js du hub (qui pose noindex, en-têtes et 403).
   * Champ deployment_configs.{production,preview}.fail_open de l'API Pages (Create project, Edit project).
   * Projet déjà là (reprise de l'étape) : le réglage est recalé s'il manque.
   */
  async createProject(name: string): Promise<CfProject> {
    const existing = await this.getProject(name);
    if (existing) {
      if (!isFailClosed(existing)) await this.setFailClosed(name);
      return existing;
    }
    try {
      const env = await this.call<{ name: string; subdomain: string }>("POST", `/accounts/${this.#account}/pages/projects`, {
        json: { name, production_branch: "main", deployment_configs: FAIL_CLOSED },
      });
      return this.toProject(env.result, name);
    } catch (err) {
      // Création concurrente ou réessai après une réponse perdue : le projet existe déjà.
      if (err instanceof CloudflareError && err.status !== null && err.status >= 400 && err.status < 500) {
        const again = await this.getProject(name);
        if (again) return again;
      }
      throw err;
    }
  }

  async listProjects(): Promise<CfProject[]> {
    const all: CfProject[] = [];
    for (let page = 1; page <= 100; page++) {
      const env = await this.call<Array<{ name: string; subdomain: string }>>("GET", `/accounts/${this.#account}/pages/projects`, {
        query: { page: String(page), per_page: String(PROJECTS_PAGE) },
      });
      const batch = env.result ?? [];
      all.push(...batch.map((p) => this.toProject(p, p.name)));
      const totalPages = env.result_info?.total_pages;
      if (batch.length < PROJECTS_PAGE || (totalPages !== undefined && page >= totalPages)) break;
    }
    return all;
  }

  async deleteProject(name: string): Promise<void> {
    await this.orNull(this.call("DELETE", this.projectPath(name)));
  }

  private toDomain(raw: { name?: string; status?: string } | undefined, hostname: string): CfDomain {
    const known: CfDomain["status"][] = ["initializing", "pending", "active", "deactivated", "blocked", "error"];
    const status = known.includes(raw?.status as CfDomain["status"]) ? (raw!.status as CfDomain["status"]) : "pending";
    return { name: raw?.name ?? hostname, status };
  }

  async getDomain(project: string, hostname: string): Promise<CfDomain | null> {
    const env = await this.orNull(
      this.call<{ name: string; status: string }>("GET", `${this.projectPath(project)}/domains/${encodeURIComponent(hostname)}`),
    );
    return env ? this.toDomain(env.result, hostname) : null;
  }

  async addDomain(project: string, hostname: string): Promise<CfDomain> {
    const existing = await this.getDomain(project, hostname);
    if (existing) return existing;
    try {
      const env = await this.call<{ name: string; status: string }>("POST", `${this.projectPath(project)}/domains`, {
        json: { name: hostname },
      });
      return this.toDomain(env.result, hostname);
    } catch (err) {
      if (err instanceof CloudflareError && err.status !== null && err.status >= 400 && err.status < 500) {
        const again = await this.getDomain(project, hostname);
        if (again) return again;
      }
      throw err;
    }
  }

  async removeDomain(project: string, hostname: string): Promise<void> {
    await this.orNull(this.call("DELETE", `${this.projectPath(project)}/domains/${encodeURIComponent(hostname)}`));
  }

  private toRecord(raw: Partial<CfDnsRecord> & { id: string }): CfDnsRecord {
    return {
      id: raw.id,
      type: raw.type ?? "",
      name: raw.name ?? "",
      content: raw.content ?? "",
      proxied: Boolean(raw.proxied),
      comment: raw.comment ?? null,
    };
  }

  async findDnsRecord(hostname: string): Promise<CfDnsRecord | null> {
    const env = await this.call<Array<CfDnsRecord>>("GET", `/zones/${this.#zone}/dns_records`, {
      query: { name: hostname, per_page: "5" },
    });
    const match = (env.result ?? []).find((r) => r.name?.toLowerCase() === hostname.toLowerCase());
    return match ? this.toRecord(match) : null;
  }

  async createCname(hostname: string, target: string, comment: string): Promise<CfDnsRecord> {
    const env = await this.call<CfDnsRecord>("POST", `/zones/${this.#zone}/dns_records`, {
      json: { type: "CNAME", name: hostname, content: target, proxied: true, ttl: 1, comment },
    });
    if (!env.result?.id) throw new CloudflareError("Réponse illisible de Cloudflare (DNS).", 200);
    return this.toRecord(env.result);
  }

  async updateCname(id: string, hostname: string, target: string, comment: string): Promise<CfDnsRecord> {
    const env = await this.call<CfDnsRecord>("PATCH", `/zones/${this.#zone}/dns_records/${encodeURIComponent(id)}`, {
      json: { type: "CNAME", name: hostname, content: target, proxied: true, ttl: 1, comment },
    });
    if (!env.result?.id) throw new CloudflareError("Réponse illisible de Cloudflare (DNS).", 200);
    return this.toRecord(env.result);
  }

  async deleteDnsRecord(id: string): Promise<void> {
    await this.orNull(this.call("DELETE", `/zones/${this.#zone}/dns_records/${encodeURIComponent(id)}`));
  }

  async listHubDnsRecords(): Promise<CfDnsRecord[]> {
    const all: CfDnsRecord[] = [];
    for (let page = 1; page <= 100; page++) {
      const env = await this.call<CfDnsRecord[]>("GET", `/zones/${this.#zone}/dns_records`, {
        query: { "comment.startswith": HUB_DNS_COMMENT_PREFIX, page: String(page), per_page: String(DNS_PAGE) },
      });
      const batch = env.result ?? [];
      all.push(...batch.map((r) => this.toRecord(r)));
      const totalPages = env.result_info?.total_pages ?? 1;
      if (batch.length < DNS_PAGE || page >= totalPages) break;
    }
    return all.filter((r) => r.comment?.startsWith(HUB_DNS_COMMENT_PREFIX));
  }

  /**
   * Envoi direct en 5 appels (voie de wrangler) : jeton d'envoi, empreintes manquantes, envoi des
   * manquants par lots en base64, enregistrement des empreintes, puis création du déploiement.
   */
  async deploy(project: string, input: DeployInput): Promise<CfDeployment> {
    const fetchJwt = async () => {
      const tokenEnv = await this.call<{ jwt: string }>("GET", `${this.projectPath(project)}/upload-token`);
      const value = tokenEnv.result?.jwt;
      if (!value) throw new CloudflareError("Cloudflare n'a pas fourni de jeton d'envoi.", 200);
      return value;
    };
    let jwt = await fetchJwt();
    let renewed = false;
    // Jeton d'envoi expiré en cours de route (gros site) : redemandé une fois, puis l'appel est rejoué.
    const assets = async <T>(path: string, json: unknown): Promise<CfEnvelope<T>> => {
      try {
        return await this.call<T>("POST", path, { bearer: jwt, json });
      } catch (err) {
        if (renewed || !(err instanceof CloudflareError) || err.status !== 401) throw err;
        renewed = true;
        jwt = await fetchJwt();
        return this.call<T>("POST", path, { bearer: jwt, json });
      }
    };

    const manifest: Record<string, string> = {};
    const byHash = new Map<string, (typeof input.files)[number]>();
    for (const file of input.files) {
      const hash = pagesAssetHash(await file.read(), file.path);
      manifest[`/${file.path}`] = hash;
      if (!byHash.has(hash)) byHash.set(hash, file);
    }
    const hashes = [...byHash.keys()];

    const missingEnv = await assets<string[]>("/pages/assets/check-missing", { hashes });
    const missing = (missingEnv.result ?? []).filter((h) => byHash.has(h));

    let bucket: Array<{ key: string; value: string; metadata: { contentType: string }; base64: true }> = [];
    let bucketBytes = 0;
    const flush = async () => {
      if (bucket.length === 0) return;
      await assets("/pages/assets/upload", bucket);
      bucket = [];
      bucketBytes = 0;
    };
    for (const hash of missing) {
      const file = byHash.get(hash)!;
      if (bucket.length >= BUCKET_FILES || (bucket.length > 0 && bucketBytes + file.size > BUCKET_BYTES)) await flush();
      const content = await file.read();
      bucket.push({ key: hash, value: content.toString("base64"), metadata: { contentType: contentTypeOf(file.path) }, base64: true });
      bucketBytes += file.size;
    }
    await flush();

    await assets("/pages/assets/upsert-hashes", { hashes });

    const form = new FormData();
    form.append("manifest", JSON.stringify(manifest));
    form.append("branch", "main");
    form.append("_worker.js", new Blob([input.workerJs], { type: "application/javascript" }), "_worker.js");
    if (input.headersFile !== undefined) form.append("_headers", new Blob([input.headersFile], { type: "text/plain" }), "_headers");
    if (input.redirectsFile !== undefined) form.append("_redirects", new Blob([input.redirectsFile], { type: "text/plain" }), "_redirects");
    const env = await this.call<{ id: string; url: string }>("POST", `${this.projectPath(project)}/deployments`, { form });
    if (!env.result?.id) throw new CloudflareError("Réponse illisible de Cloudflare (déploiement).", 200);
    return { id: env.result.id, url: env.result.url ?? "" };
  }

  /**
   * GET /accounts/{account_id}/pages/projects/{project_name}/deployments (page, per_page) : du plus récent au
   * plus ancien. Les 4 premières pages suffisent à retrouver les déploiements d'une tentative récente.
   */
  async listDeployments(project: string): Promise<CfDeploymentInfo[]> {
    const out: CfDeploymentInfo[] = [];
    for (let page = 1; page <= 4; page++) {
      const env = await this.call<Array<{ id: string; url?: string; created_on?: string }>>("GET", `${this.projectPath(project)}/deployments`, {
        query: { page: String(page), per_page: "25" },
      });
      const list = env.result ?? [];
      for (const d of list) if (d.id && d.created_on) out.push({ id: d.id, url: d.url ?? "", createdOn: d.created_on });
      if (list.length < 25) break;
    }
    return out;
  }

  async deleteDeployment(project: string, id: string): Promise<void> {
    await this.orNull(
      this.call("DELETE", `${this.projectPath(project)}/deployments/${encodeURIComponent(id)}`, { query: { force: "true" } }),
    );
  }
}
