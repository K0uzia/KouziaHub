import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildHtaccess,
  buildPagesHeaders,
  buildPagesRedirects,
  CACHE_RULES,
  GENERATED_MARKER,
  normalizeFinalDomain,
  notFoundPageError,
  pagesDeployConfig,
  type ServerProfile,
} from "@/lib/server-config.js";
import { classifySitePath } from "@/lib/site-paths.js";
import { buildWorkerScript } from "@/lib/worker-script.js";

const base: ServerProfile = { finalDomain: null, canonicalHost: "www", notFoundPage: "/404.html" };
const hostRules = (h: string) => h.split("\n").filter((l) => /RewriteCond %\{HTTP_HOST\}/.test(l));

describe("générateur du .htaccess", () => {
  it("commence par le marqueur du hub et l'explication", () => {
    const h = buildHtaccess(base);
    expect(h.split("\n")[0]).toBe(`${GENERATED_MARKER} Modifiable : le hub ne l'écrase plus s'il est modifié à la main`);
  });

  it("sans domaine final : HTTPS en 301, aucune redirection d'hôte, commentaire explicatif, HSTS commenté", () => {
    const h = buildHtaccess(base);
    expect(hostRules(h)).toEqual([]);
    expect(h).toContain("Domaine final pas encore renseigné dans le hub : aucune redirection d'hôte");
    expect(h).toContain("RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L,NE]");
    expect(h).toContain('    # Header always set Strict-Transport-Security "max-age=31536000"');
    expect(h).not.toMatch(/^\s*Header always set Strict-Transport-Security/m);
  });

  it("domaine final en www : apex redirigé vers www, HTTPS vers la forme canonique, HSTS sur le domaine final", () => {
    const h = buildHtaccess({ ...base, finalDomain: "client-exemple.fr", canonicalHost: "www" });
    expect(h).toContain("RewriteCond %{HTTP_HOST} ^client-exemple\\.fr$ [NC]\n    RewriteRule ^ https://www.client-exemple.fr%{REQUEST_URI} [R=301,L,NE]");
    expect(h).toContain("RewriteCond %{HTTP_HOST} ^(www\\.)?client-exemple\\.fr$ [NC]\n    RewriteRule ^ https://www.client-exemple.fr%{REQUEST_URI} [R=301,L,NE]");
    expect(h).toContain('SetEnvIf Host "^(www\\.)?client-exemple\\.fr$" FINAL_HOST');
    expect(h).toContain('Header always set Strict-Transport-Security "max-age=31536000" env=FINAL_HOST');
  });

  it("domaine final en apex : www redirigé vers le domaine nu", () => {
    const h = buildHtaccess({ ...base, finalDomain: "client-exemple.fr", canonicalHost: "apex" });
    expect(h).toContain("RewriteCond %{HTTP_HOST} ^www\\.client-exemple\\.fr$ [NC]\n    RewriteRule ^ https://client-exemple.fr%{REQUEST_URI} [R=301,L,NE]");
    expect(h).not.toContain("https://www.client-exemple.fr");
  });

  it("page 404 du profil, sécurité, compression, cache et fichiers de dev", () => {
    const h = buildHtaccess({ ...base, notFoundPage: "/erreurs/introuvable.html" });
    expect(h).toContain("ErrorDocument 404 /erreurs/introuvable.html");
    expect(h).toContain("Options -Indexes");
    expect(h).toContain("ServerSignature Off");
    for (const header of ["X-Content-Type-Options", "X-Frame-Options \"SAMEORIGIN\"", "Referrer-Policy \"strict-origin-when-cross-origin\"", "Permissions-Policy", "Cross-Origin-Opener-Policy \"same-origin\""]) {
      expect(h).toContain(header);
    }
    const csp = /Content-Security-Policy "([^"]+)"/.exec(h)![1]!;
    for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'", "img-src 'self' data: https:"]) {
      expect(csp).toContain(d);
    }
    expect(h).toContain("<IfModule mod_brotli.c>");
    expect(h).toContain("<IfModule mod_deflate.c>");
    expect(h).toContain("RewriteRule (^|/)\\.(?!well-known/) - [F,L]");
    const devFiles = /<FilesMatch "([^"]+)">\s*Require all denied/.exec(h)![1]!;
    for (const ext of ["env", "log", "md", "markdown", "bak", "map", "swp"]) expect(devFiles).toContain(ext);
    expect(h).toContain('Header set Cache-Control "public, max-age=31536000, immutable"');
    expect(h).toContain('Header set Cache-Control "public, max-age=604800"');
    expect(h).toContain('Header set Cache-Control "public, max-age=2592000"');
    expect(h).toContain('Header set Cache-Control "public, max-age=0, must-revalidate"');
    // Règle la plus précise (hashés) en dernier : sous Apache, la dernière FilesMatch l'emporte.
    expect(h.lastIndexOf("immutable")).toBeGreaterThan(h.lastIndexOf("max-age=604800"));
  });

  it("chaque directive de module est sous IfModule (balises équilibrées)", () => {
    const h = buildHtaccess({ ...base, finalDomain: "a.fr" });
    expect((h.match(/<IfModule/g) ?? []).length).toBe((h.match(/<\/IfModule>/g) ?? []).length);
    for (const directive of ["RewriteRule", "Header ", "AddOutputFilterByType", "SetEnvIf", "Require all denied"]) {
      for (const line of h.split("\n").filter((l) => l.trimStart().startsWith(directive))) {
        expect(line.startsWith("    "), line).toBe(true);
      }
    }
  });

  it("valide le domaine final et la page 404", () => {
    expect(normalizeFinalDomain("WWW.Client.fr")).toEqual({ ok: true, value: "client.fr" });
    expect(normalizeFinalDomain("https://client.fr").ok).toBe(false);
    expect(normalizeFinalDomain("client.fr/page").ok).toBe(false);
    expect(normalizeFinalDomain("localhost").ok).toBe(false);
    expect(notFoundPageError("/404.html")).toBeNull();
    expect(notFoundPageError("/erreurs/404.html")).toBeNull();
    for (const bad of ["404.html", "/../x.html", "/.cache/x.html", "/a//b.html", "/404.php"]) expect(notFoundPageError(bad), bad).not.toBeNull();
  });

  it(".htaccess est accepté par les contrôles de chemins (fichier caché utile)", () => {
    expect(classifySitePath(".htaccess")).toEqual({ action: "accept" });
  });
});

describe("configuration Pages (fusion au déploiement)", () => {
  it("_headers : cache du hub d'abord, puis les règles du site", () => {
    const merged = buildPagesHeaders("/*\n  X-Site: 1");
    expect(merged!.indexOf("/assets/*")).toBeLessThan(merged!.indexOf("X-Site: 1"));
    expect(buildPagesHeaders()).toContain("/_astro/*\n  Cache-Control: public, max-age=31536000, immutable");
  });

  it("_headers du site qui pose Cache-Control : aucune règle de cache du hub (Pages joindrait les valeurs)", () => {
    const user = "/*\n  Cache-Control: no-store";
    expect(buildPagesHeaders(user)).toBe("# Règles du site\n/*\n  Cache-Control: no-store\n");
    expect(pagesDeployConfig(base, new Set(), { headers: user }).cacheRules).toBe(false);
  });

  it("_redirects : aucune règle du hub, celui du site passe tel quel", () => {
    expect(buildPagesRedirects()).toBeUndefined();
    expect(buildPagesRedirects("/ancien /nouveau 301")).toBe("/ancien /nouveau 301\n");
  });

  it("page 404 d'un autre nom : copiée en 404.html seulement si elle existe et que 404.html manque", () => {
    const profile = { ...base, notFoundPage: "/introuvable.html" };
    expect(pagesDeployConfig(profile, new Set(["index.html", "introuvable.html"]), {}).notFoundCopyFrom).toBe("introuvable.html");
    expect(pagesDeployConfig(profile, new Set(["introuvable.html", "404.html"]), {}).notFoundCopyFrom).toBeNull();
    expect(pagesDeployConfig(profile, new Set(["index.html"]), {}).notFoundCopyFrom).toBeNull();
    expect(pagesDeployConfig(base, new Set(["404.html"]), {}).notFoundCopyFrom).toBeNull();
  });
});

describe("cache posé par le _worker.js (même source)", () => {
  const load = async (cacheRules: boolean) => {
    const file = join(mkdtempSync(join(tmpdir(), "kouzia-hub-worker-cache-")), "_worker.mjs");
    writeFileSync(file, buildWorkerScript("alpha.kouzia.com", { cacheRules }));
    return ((await import(pathToFileURL(file).href)) as { default: { fetch(r: Request, e: unknown): Promise<Response> } }).default;
  };
  const env = (status = 200) => ({ ASSETS: { fetch: async () => new Response("x", { status, headers: { "Cache-Control": "public, max-age=0, must-revalidate" } }) } });

  it("applique la première règle qui correspond", async () => {
    const worker = await load(true);
    const cc = async (path: string, status = 200) => (await worker.fetch(new Request(`https://alpha.kouzia.com${path}`), env(status))).headers.get("Cache-Control");
    expect(await cc("/assets/index.Bx3k9aZq.js")).toBe(CACHE_RULES[0]!.cacheControl);
    expect(await cc("/css/style.css")).toBe("public, max-age=604800");
    expect(await cc("/img/photo.webp")).toBe("public, max-age=2592000");
    expect(await cc("/fonts/x.woff2")).toBe("public, max-age=31536000");
    expect(await cc("/")).toBe("public, max-age=0, must-revalidate");
    expect(await cc("/contact")).toBe("public, max-age=0, must-revalidate");
    expect(await cc("/absent.css", 404)).toBe("public, max-age=0, must-revalidate");
  });

  it("règles coupées quand le site pose son propre Cache-Control", async () => {
    const worker = await load(false);
    const res = await worker.fetch(new Request("https://alpha.kouzia.com/css/style.css"), env());
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
  });
});
