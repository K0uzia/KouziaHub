import { beforeEach, describe, expect, it } from "vitest";
import { pagesAssetHash } from "@/lib/cloudflare/hash.js";
import { RealCloudflare } from "@/lib/cloudflare/real.js";
import { CloudflareError } from "@/lib/cloudflare/types.js";

// Faux serveur de l'API Cloudflare en mémoire : aucun appel réseau. Chaque requête est enregistrée
// (méthode, chemin, requête, jeton, corps) puis servie par une route déclarée dans le test.
type Recorded = { method: string; path: string; query: URLSearchParams; auth: string | null; json?: unknown; form?: FormData };
type Handler = (req: Recorded) => { status?: number; body?: unknown; headers?: Record<string, string> };

const TOKEN = "jeton-de-test-ne-pas-journaliser";
const JWT = "jwt-d-envoi-de-test";

class FakeApi {
  readonly requests: Recorded[] = [];
  private readonly routes: Array<{ method: string; path: string; handler: Handler }> = [];

  on(method: string, path: string, handler: Handler): this {
    this.routes.unshift({ method, path, handler });
    return this;
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.cloudflare.com");
    const headers = new Headers(init?.headers);
    const req: Recorded = {
      method: init?.method ?? "GET",
      path: url.pathname.replace(/^\/client\/v4/, ""),
      query: url.searchParams,
      auth: headers.get("authorization"),
    };
    if (typeof init?.body === "string") req.json = JSON.parse(init.body);
    if (init?.body instanceof FormData) req.form = init.body;
    this.requests.push(req);
    const route = this.routes.find((r) => r.method === req.method && r.path === req.path);
    const out = route ? route.handler(req) : { status: 404, body: { success: false, errors: [{ code: 7003, message: "No route" }] } };
    return new Response(JSON.stringify(out.body ?? { success: true, result: null }), {
      status: out.status ?? 200,
      headers: { "Content-Type": "application/json", ...(out.headers ?? {}) },
    });
  }) as typeof fetch;
}

const ok = (result: unknown, extra: Record<string, unknown> = {}) => ({ body: { success: true, errors: [], result, ...extra } });
const P = "/accounts/acc1/pages/projects";

let api: FakeApi;
let sleeps: number[];
let cf: RealCloudflare;

beforeEach(() => {
  api = new FakeApi();
  sleeps = [];
  cf = new RealCloudflare({
    token: TOKEN,
    accountId: "acc1",
    zoneId: "zone1",
    fetch: api.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
});

describe("empreinte des fichiers (comme wrangler)", () => {
  it("blake3 du base64 suivi de l'extension, tronqué à 32 caractères hexadécimaux", () => {
    // Vecteur officiel blake3("") = af1349b9f5f9a1a6a0404dea36dcc9499bcc25c9adc112b7cc9a93cae41f3262.
    expect(pagesAssetHash(Buffer.alloc(0), "LICENSE")).toBe("af1349b9f5f9a1a6a0404dea36dcc949");
    expect(pagesAssetHash(Buffer.from("x"), "a.css")).toHaveLength(32);
    expect(pagesAssetHash(Buffer.from("x"), "a.css")).not.toBe(pagesAssetHash(Buffer.from("x"), "a.js"));
    expect(pagesAssetHash(Buffer.from("x"), "a.CSS")).not.toBe(pagesAssetHash(Buffer.from("x"), "a.css"));
  });
});

describe("adaptateur Cloudflare réel (fetch injecté)", () => {
  it("crée un projet avec production_branch main, en jeton API", async () => {
    api.on("POST", P, (req) => {
      expect(req.json).toEqual({ name: "kz-alpha", production_branch: "main" });
      return ok({ name: "kz-alpha", subdomain: "kz-alpha-x1y.pages.dev" });
    });
    const project = await cf.createProject("kz-alpha");
    expect(project).toEqual({ name: "kz-alpha", subdomain: "kz-alpha-x1y.pages.dev" });
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`GET ${P}/kz-alpha`, `POST ${P}`]);
    expect(api.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("création idempotente : renvoie le projet existant sans POST", async () => {
    api.on("GET", `${P}/kz-alpha`, () => ok({ name: "kz-alpha", subdomain: "kz-alpha.pages.dev" }));
    await cf.createProject("kz-alpha");
    expect(api.requests.map((r) => r.method)).toEqual(["GET"]);
  });

  it("liste les projets page par page", async () => {
    api.on("GET", P, (req) => {
      const page = Number(req.query.get("page"));
      const count = page === 1 ? 10 : 3;
      return ok(Array.from({ length: count }, (_, i) => ({ name: `p${page}-${i}`, subdomain: `p${page}-${i}.pages.dev` })), {
        result_info: { page, per_page: 10, total_pages: 2 },
      });
    });
    expect(await cf.listProjects()).toHaveLength(13);
    expect(api.requests.map((r) => r.query.get("page"))).toEqual(["1", "2"]);
  });

  it("suppressions idempotentes : 404 n'est pas une erreur", async () => {
    await expect(cf.deleteProject("kz-absent")).resolves.toBeUndefined();
    await expect(cf.removeDomain("kz-a", "a.kouzia.com")).resolves.toBeUndefined();
    await expect(cf.deleteDnsRecord("rec1")).resolves.toBeUndefined();
    await expect(cf.deleteDeployment("kz-a", "dep1")).resolves.toBeUndefined();
    const del = api.requests.find((r) => r.path === `${P}/kz-a/deployments/dep1`)!;
    expect(del.method).toBe("DELETE");
    expect(del.query.get("force")).toBe("true");
  });

  it("domaine : ajout idempotent puis statut", async () => {
    let added = false;
    api.on("GET", `${P}/kz-a/domains/a.kouzia.com`, () =>
      added ? ok({ name: "a.kouzia.com", status: "pending" }) : { status: 404, body: { success: false, errors: [{ code: 8000009, message: "not found" }] } },
    );
    api.on("POST", `${P}/kz-a/domains`, (req) => {
      expect(req.json).toEqual({ name: "a.kouzia.com" });
      added = true;
      return ok({ name: "a.kouzia.com", status: "initializing" });
    });
    expect((await cf.addDomain("kz-a", "a.kouzia.com")).status).toBe("initializing");
    expect((await cf.addDomain("kz-a", "a.kouzia.com")).status).toBe("pending");
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("DNS : recherche par nom, CNAME proxifié commenté, liste des enregistrements du hub", async () => {
    api.on("GET", "/zones/zone1/dns_records", (req) => {
      if (req.query.get("name")) return ok([{ id: "r0", type: "A", name: "www.kouzia.com", content: "1.2.3.4", proxied: true, comment: null }]);
      expect(req.query.get("comment.startswith")).toBe("kouzia-hub:");
      return ok([{ id: "r1", type: "CNAME", name: "a.kouzia.com", content: "kz-a.pages.dev", proxied: true, comment: "kouzia-hub:s1" }], {
        result_info: { total_pages: 1 },
      });
    });
    api.on("POST", "/zones/zone1/dns_records", (req) => {
      expect(req.json).toEqual({ type: "CNAME", name: "a.kouzia.com", content: "kz-a.pages.dev", proxied: true, ttl: 1, comment: "kouzia-hub:s1" });
      return ok({ id: "r9", type: "CNAME", name: "a.kouzia.com", content: "kz-a.pages.dev", proxied: true, comment: "kouzia-hub:s1" });
    });
    expect((await cf.findDnsRecord("www.kouzia.com"))?.type).toBe("A");
    expect(api.requests[0]!.query.get("name")).toBe("www.kouzia.com");
    expect((await cf.createCname("a.kouzia.com", "kz-a.pages.dev", "kouzia-hub:s1")).id).toBe("r9");
    expect(await cf.listHubDnsRecords()).toHaveLength(1);
  });

  it("déploiement en 5 appels : jeton d'envoi, manquants, envoi par lots, empreintes, déploiement", async () => {
    const files = {
      "index.html": Buffer.from("<h1>alpha</h1>"),
      "css/a.css": Buffer.from("a{color:red}"),
      "copie.html": Buffer.from("<h1>alpha</h1>"),
    };
    const hashIndex = pagesAssetHash(files["index.html"], "index.html");
    const hashCss = pagesAssetHash(files["css/a.css"], "css/a.css");
    api.on("GET", `${P}/kz-a/upload-token`, () => ok({ jwt: JWT }));
    api.on("POST", "/pages/assets/check-missing", (req) => {
      expect(req.auth).toBe(`Bearer ${JWT}`);
      expect((req.json as { hashes: string[] }).hashes.sort()).toEqual([hashIndex, hashCss].sort());
      return ok([hashCss]);
    });
    api.on("POST", "/pages/assets/upload", (req) => {
      expect(req.auth).toBe(`Bearer ${JWT}`);
      expect(req.json).toEqual([{ key: hashCss, value: files["css/a.css"].toString("base64"), metadata: { contentType: "text/css" }, base64: true }]);
      return ok(null);
    });
    api.on("POST", "/pages/assets/upsert-hashes", (req) => {
      expect(req.auth).toBe(`Bearer ${JWT}`);
      expect((req.json as { hashes: string[] }).hashes.sort()).toEqual([hashIndex, hashCss].sort());
      return ok(null);
    });
    api.on("POST", `${P}/kz-a/deployments`, (req) => {
      expect(req.auth).toBe(`Bearer ${TOKEN}`);
      return ok({ id: "dep-1", url: "https://abcd.kz-a.pages.dev" });
    });

    const deployment = await cf.deploy("kz-a", {
      files: Object.entries(files).map(([path, content]) => ({ path, sha256: "x", size: content.length, read: async () => content })),
      workerJs: "export default {}",
      headersFile: "/*\n  X-Test: 1\n",
    });
    expect(deployment).toEqual({ id: "dep-1", url: "https://abcd.kz-a.pages.dev" });
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET ${P}/kz-a/upload-token`,
      "POST /pages/assets/check-missing",
      "POST /pages/assets/upload",
      "POST /pages/assets/upsert-hashes",
      `POST ${P}/kz-a/deployments`,
    ]);
    const form = api.requests[4]!.form!;
    expect(JSON.parse(String(form.get("manifest")))).toEqual({ "/index.html": hashIndex, "/css/a.css": hashCss, "/copie.html": hashIndex });
    expect(form.get("branch")).toBe("main");
    const worker = form.get("_worker.js") as File;
    expect(worker.name).toBe("_worker.js");
    expect(await worker.text()).toBe("export default {}");
    expect(await (form.get("_headers") as File).text()).toBe("/*\n  X-Test: 1\n");
    expect(form.get("_redirects")).toBeNull();
  });

  it("réessaie sur 503 puis réussit, en respectant Retry-After sur 429", async () => {
    let calls = 0;
    api.on("GET", `${P}/kz-a`, () => {
      calls++;
      if (calls === 1) return { status: 503, body: { success: false, errors: [] } };
      if (calls === 2) return { status: 429, body: { success: false, errors: [] }, headers: { "Retry-After": "2" } };
      return ok({ name: "kz-a", subdomain: "kz-a.pages.dev" });
    });
    expect(await cf.getProject("kz-a")).toEqual({ name: "kz-a", subdomain: "kz-a.pages.dev" });
    expect(sleeps).toEqual([500, 2000]);
  });

  it("abandonne après 3 tentatives avec un message en français", async () => {
    api.on("GET", `${P}/kz-a`, () => ({ status: 500, body: { success: false, errors: [{ code: 8000000, message: "boom" }] } }));
    await expect(cf.getProject("kz-a")).rejects.toMatchObject({ status: 500, message: expect.stringMatching(/indisponible/) });
    expect(api.requests).toHaveLength(3);
  });

  it("traduit un refus d'accès sans jamais recopier le jeton", async () => {
    api.on("GET", `${P}/kz-a`, () => ({ status: 403, body: { success: false, errors: [{ code: 10000, message: `Authentication error for ${TOKEN}` }] } }));
    const err = (await cf.getProject("kz-a").catch((e: unknown) => e)) as CloudflareError;
    expect(err).toBeInstanceOf(CloudflareError);
    expect(err.message).toMatch(/jeton invalide/);
    expect(err.message).not.toContain(TOKEN);
    expect(api.requests).toHaveLength(1);
  });

  it("erreur réseau : message français, réessais bornés", async () => {
    const failing = new RealCloudflare({
      token: TOKEN,
      accountId: "a",
      zoneId: "z",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      sleep: async () => undefined,
    });
    await expect(failing.listProjects()).rejects.toMatchObject({ message: expect.stringMatching(/injoignable/) });
  });

  it("refuse de démarrer sans compte ni zone", () => {
    expect(() => new RealCloudflare({ token: TOKEN, accountId: "", zoneId: "z" })).toThrow(/requis/);
  });
});
