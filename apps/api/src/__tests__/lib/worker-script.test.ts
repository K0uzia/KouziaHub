import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildWorkerScript, MINIMAL_SITE_CSP, SITE_HEADERS } from "@/lib/worker-script.js";

type Worker = { fetch(request: Request, env: { ASSETS: { fetch(r: Request): Promise<Response> } }): Promise<Response> };

let worker: Worker;
const served: string[] = [];
const env = {
  ASSETS: {
    async fetch(request: Request) {
      served.push(request.url);
      return new Response("<h1>site</h1>", { status: 200, headers: { "Content-Type": "text/html" } });
    },
  },
};

beforeAll(async () => {
  // Le programme est exécuté tel qu'il part chez Cloudflare (module ES), avec un faux env.ASSETS.
  const dir = mkdtempSync(join(tmpdir(), "kouzia-hub-worker-"));
  const file = join(dir, "_worker.mjs");
  writeFileSync(file, buildWorkerScript("alpha.kouzia.com"));
  worker = ((await import(pathToFileURL(file).href)) as { default: Worker }).default;
});

const expectSiteHeaders = (res: Response) => {
  for (const [name, value] of Object.entries(SITE_HEADERS)) expect(res.headers.get(name)).toBe(value);
  expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  // CSP minimale : rien d'utile au site n'est restreint (ni script, ni style, ni image).
  expect(res.headers.get("Content-Security-Policy")).toBe(MINIMAL_SITE_CSP);
};

describe("_worker.js injecté", () => {
  it("redirige pages.dev en 301 vers le sous-domaine, chemin et requête conservés", async () => {
    const res = await worker.fetch(new Request("https://kz-alpha.pages.dev/contact/?a=1&b=2"), env);
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://alpha.kouzia.com/contact/?a=1&b=2");
    expectSiteHeaders(res);
  });

  it("redirige l'adresse d'un déploiement (<hash>.<projet>.pages.dev)", async () => {
    const res = await worker.fetch(new Request("https://3f2a1b9c.kz-alpha.pages.dev/"), env);
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://alpha.kouzia.com/");
  });

  it("sert robots.txt en Disallow sans passer par les fichiers du site", async () => {
    served.length = 0;
    const res = await worker.fetch(new Request("https://alpha.kouzia.com/robots.txt"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("User-agent: *\nDisallow: /\n");
    expect(served).toEqual([]);
    expectSiteHeaders(res);
  });

  it("sert les fichiers du site avec noindex et les en-têtes de sécurité", async () => {
    served.length = 0;
    const res = await worker.fetch(new Request("https://alpha.kouzia.com/index.html"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>site</h1>");
    expect(res.headers.get("Content-Type")).toBe("text/html");
    expect(served).toEqual(["https://alpha.kouzia.com/index.html"]);
    expectSiteHeaders(res);
  });

  it("n'insère le nom d'hôte que comme littéral JSON", () => {
    const script = buildWorkerScript('x";alert(1);"');
    expect(script).toContain('const HOST = "x\\";alert(1);\\"";');
  });
});

describe("fichiers de développement jamais servis", () => {
  it.each([
    "/.env",
    "/.git/config",
    "/assets/.secret/x.js",
    "/%2egit/config",
    "/README.md",
    "/docs/notes.markdown",
    "/debug.log",
    "/index.html.bak",
    "/app.js.map",
    "/.index.html.swp",
    "/index.html~",
    "/contact.php",
    "/app/Controller.PHP",
    "/.claude/settings.json",
    "/.gitignore",
  ])("%s : 403 avec les en-têtes du hub, sans lire les fichiers", async (path) => {
    served.length = 0;
    const res = await worker.fetch(new Request(`https://alpha.kouzia.com${path}`), env);
    expect(res.status).toBe(403);
    expect(served).toEqual([]);
    expectSiteHeaders(res);
  });

  it.each(["/.well-known/security.txt", "/index.html", "/assets/app.js", "/mdfile.html", "/php.html", "/readme-site.html"])("%s : servi", async (path) => {
    const res = await worker.fetch(new Request(`https://alpha.kouzia.com${path}`), env);
    expect(res.status).toBe(200);
  });
});

/** Programme généré avec ses options, chargé comme chez Cloudflare. */
async function loadWorker(options: Parameters<typeof buildWorkerScript>[1]): Promise<Worker> {
  const dir = mkdtempSync(join(tmpdir(), "kouzia-hub-worker-"));
  const file = join(dir, "_worker.mjs");
  writeFileSync(file, buildWorkerScript("alpha.kouzia.com", options));
  return ((await import(pathToFileURL(file).href)) as { default: Worker }).default;
}

describe("_worker.js : outillage du projet, CSP et page 404 (retour de production du 19/10/2026)", () => {
  const site = (path: string) => new Request(`https://alpha.kouzia.com${path}`);

  it("outillage refusé en 403 (package.json resté d'un ancien envoi compris) ; un .config.js hors racine est servi", async () => {
    const w = await loadWorker({});
    for (const p of ["/package.json", "/package-lock.json", "/yarn.lock", "/tsconfig.app.json", "/vite.config.ts", "/tailwind.config.js", "/Dockerfile", "/docker-compose.prod.yml", "/src/main.js", "/dist/package.json", "/Makefile"]) {
      served.length = 0;
      const res = await w.fetch(site(p), env);
      expect(res.status, p).toBe(403);
      expect(served, p).toEqual([]);
    }
    for (const p of ["/js/app.config.js", "/assets/src/logo.png", "/data.json"]) expect((await w.fetch(site(p), env)).status, p).toBe(200);
  });

  it("exceptions du site : chemins exacts seulement, le reste toujours refusé", async () => {
    const w = await loadWorker({ allow: ["data/package.json", "src/img/a.png"] });
    expect((await w.fetch(site("/data/package.json"), env)).status).toBe(200);
    expect((await w.fetch(site("/src/img/a.png"), env)).status).toBe(200);
    expect((await w.fetch(site("/src/img/b.png"), env)).status).toBe(403);
    expect((await w.fetch(site("/package.json"), env)).status).toBe(403);
    expect((await w.fetch(site("/.env"), env)).status).toBe(403);
  });

  it("CSP minimale par défaut ; CSP du site ajoutée, sans affaiblir frame-ancestors ni object-src", async () => {
    expect((await (await loadWorker({})).fetch(site("/"), env)).headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors 'self'; object-src 'none'; base-uri 'self'; upgrade-insecure-requests",
    );
    const own = "default-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors *; object-src *";
    expect((await (await loadWorker({ csp: own })).fetch(site("/"), env)).headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors 'self'; object-src 'none'; base-uri 'none'; upgrade-insecure-requests; default-src 'self'; img-src 'self' data:",
    );
  });

  it("page 404 du site servie avec le statut 404 ; sans 404.html, la réponse de Pages passe telle quelle", async () => {
    const pages = {
      ASSETS: {
        async fetch(request: Request) {
          const path = new URL(request.url).pathname;
          if (path === "/404.html") return new Response("<h1>Introuvable</h1>", { status: 200, headers: { "Content-Type": "text/html" } });
          return new Response("Not Found", { status: 404 });
        },
      },
    };
    const with404 = await (await loadWorker({ has404: true })).fetch(site("/page-absente"), pages);
    expect(with404.status).toBe(404);
    expect(await with404.text()).toBe("<h1>Introuvable</h1>");
    expect(with404.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const head = await (await loadWorker({ has404: true })).fetch(new Request("https://alpha.kouzia.com/page-absente", { method: "HEAD" }), pages);
    expect(head.status).toBe(404);
    const without = await (await loadWorker({ has404: false })).fetch(site("/page-absente"), pages);
    expect(without.status).toBe(404);
    expect(await without.text()).toBe("Not Found");
  });
});

describe("_worker.js : indexation autorisée (cinquième série, 22/10/2026)", () => {
  const site = (path: string) => new Request(`https://alpha.kouzia.com${path}`);
  const pages = {
    ASSETS: {
      async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /brouillons/\n", { status: 200, headers: { "Content-Type": "text/plain" } });
        return new Response("<h1>site</h1>", { status: 200, headers: { "Content-Type": "text/html" } });
      },
    },
  };

  it("désactivée (défaut) : noindex et robots.txt en Disallow, même si le site a son robots.txt", async () => {
    const w = await loadWorker({});
    expect((await w.fetch(site("/"), pages)).headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await (await w.fetch(site("/robots.txt"), pages)).text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("activée : plus de X-Robots-Tag ; robots.txt généré avec la ligne Sitemap absolue si le sitemap existe", async () => {
    const w = await loadWorker({ indexing: { siteRobots: false, sitemap: "sitemap-index.xml" } });
    const home = await w.fetch(site("/"), pages);
    expect(home.headers.get("X-Robots-Tag")).toBeNull();
    expect(home.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await (await w.fetch(site("/robots.txt"), pages)).text()).toBe("User-agent: *\nAllow: /\n\nSitemap: https://alpha.kouzia.com/sitemap-index.xml\n");
    const noSitemap = await loadWorker({ indexing: { siteRobots: false, sitemap: null } });
    expect(await (await noSitemap.fetch(site("/robots.txt"), pages)).text()).toBe("User-agent: *\nAllow: /\n");
  });

  it("activée avec un robots.txt du site : servi tel quel ; pages.dev toujours en 301 et noindex", async () => {
    const w = await loadWorker({ indexing: { siteRobots: true, sitemap: null } });
    expect(await (await w.fetch(site("/robots.txt"), pages)).text()).toBe("User-agent: *\nDisallow: /brouillons/\n");
    const redirect = await w.fetch(new Request("https://kz-alpha.pages.dev/page"), pages);
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    // Les fichiers de développement restent refusés.
    expect((await w.fetch(site("/package.json"), pages)).status).toBe(403);
  });
});
