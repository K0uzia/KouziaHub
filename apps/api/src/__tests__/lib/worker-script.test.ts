import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildWorkerScript, SITE_HEADERS } from "@/lib/worker-script.js";

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
  expect(res.headers.get("Content-Security-Policy")).toBeNull();
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
  ])("%s : 403 avec les en-têtes du hub, sans lire les fichiers", async (path) => {
    served.length = 0;
    const res = await worker.fetch(new Request(`https://alpha.kouzia.com${path}`), env);
    expect(res.status).toBe(403);
    expect(served).toEqual([]);
    expectSiteHeaders(res);
  });

  it.each(["/.well-known/security.txt", "/index.html", "/assets/app.js", "/mdfile.html"])("%s : servi", async (path) => {
    const res = await worker.fetch(new Request(`https://alpha.kouzia.com${path}`), env);
    expect(res.status).toBe(200);
  });
});
