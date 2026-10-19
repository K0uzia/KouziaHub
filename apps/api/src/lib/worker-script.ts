import { CACHE_RULES, mergeCsp } from "@/lib/server-config.js";
import { DEV_TOOLING } from "@/lib/site-paths.js";

/** Corps de robots.txt des versions de travail (et du hub) : rien n'est à explorer. */
export const NOINDEX_ROBOTS = "User-agent: *\nDisallow: /\n";

/**
 * CSP minimale de la version de travail (règle web-security), qui ne peut rien casser : elle ne restreint ni les
 * scripts, ni les styles, ni les images. Une « CSP du site » s'y ajoute (mergeCsp), sans toucher frame-ancestors
 * ni object-src.
 */
export const MINIMAL_SITE_CSP = "frame-ancestors 'self'; object-src 'none'; base-uri 'self'; upgrade-insecure-requests";

/** En-têtes ajoutés à toute réponse d'un site client (CSP à part : minimale ou celle du site). */
export const SITE_HEADERS: Record<string, string> = {
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
  // Isole la fenêtre du site des fenêtres ouvertes par d'autres origines (window.opener).
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
};

/**
 * Programme _worker.js (mode avancé de Pages Functions) injecté par le hub dans chaque déploiement.
 * Les valeurs sont insérées par JSON.stringify : aucune chaîne ne peut sortir de son littéral.
 */
export type WorkerOptions = {
  cacheRules?: boolean;
  /** Exceptions du site aux fichiers d'outillage (onglet Serveur) : chemins exacts seulement. */
  allow?: readonly string[];
  /** CSP du site (onglet Serveur), ajoutée à la CSP minimale sans l'affaiblir. */
  csp?: string | null;
  /** Le déploiement contient 404.html : toute réponse 404 sert cette page, avec le statut 404. */
  has404?: boolean;
};

export function buildWorkerScript(hostname: string, options: WorkerOptions = {}): string {
  const host = hostname.toLowerCase();
  // Cache posé aussi par le worker : _headers ne s'appliquerait peut-être pas derrière env.ASSETS.fetch.
  const cache = options.cacheRules === false ? [] : CACHE_RULES.map((r) => [r.pattern, r.cacheControl]);
  const headers = { ...SITE_HEADERS, "Content-Security-Policy": mergeCsp(MINIMAL_SITE_CSP, options.csp) };
  return `// Généré par le hub Kouzia : ne pas modifier.
const HOST = ${JSON.stringify(host)};
const ROBOTS = ${JSON.stringify(NOINDEX_ROBOTS)};
const HEADERS = ${JSON.stringify(headers)};
const CACHE = ${JSON.stringify(cache)}.map(([pattern, value]) => [new RegExp(pattern, "i"), value]);
const TOOLING = ${JSON.stringify(DEV_TOOLING)};
const TOOLING_PATTERNS = TOOLING.patterns.map((p) => new RegExp(p, "i"));
const TOOLING_ROOT = TOOLING.rootPatterns.map((p) => new RegExp(p, "i"));
const ALLOW = ${JSON.stringify(options.allow ?? [])};
const HAS_404 = ${JSON.stringify(options.has404 === true)};

function allowed(path) {
  return ALLOW.includes(path);
}

// Fichiers de développement jamais servis (403) : segment caché sauf /.well-known/, notes, journaux,
// sauvegardes et cartes de sources, outillage du projet (package.json, verrous, configuration de build, src/
// à la racine), sauf exception du site. Testé sur le chemin décodé (%2e ne contourne pas la règle).
function isForbidden(pathname) {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {}
  const segments = path.split("/").filter(Boolean);
  if (segments.some((s, i) => s.startsWith(".") && !(i === 0 && s === ".well-known"))) return true;
  if (/\\.(md|markdown|log|bak|map|swp)$|~$/i.test(path)) return true;
  const rel = segments.join("/");
  const base = segments[segments.length - 1] || "";
  const tooling =
    TOOLING.names.includes(base.toLowerCase()) ||
    TOOLING_PATTERNS.some((re) => re.test(base)) ||
    (segments.length === 1 && TOOLING_ROOT.some((re) => re.test(base))) ||
    (segments.length > 1 && TOOLING.rootDirs.includes(segments[0].toLowerCase()));
  return tooling && !allowed(rel);
}

function withHeaders(response) {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(HEADERS)) out.headers.set(name, value);
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== HOST) {
      return withHeaders(new Response(null, { status: 301, headers: { Location: "https://" + HOST + url.pathname + url.search } }));
    }
    if (url.pathname === "/robots.txt") {
      return withHeaders(new Response(ROBOTS, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }));
    }
    if (isForbidden(url.pathname)) {
      return withHeaders(new Response("Accès refusé", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } }));
    }
    let asset = await env.ASSETS.fetch(request);
    // Page introuvable : la page 404 du site, toujours avec le statut 404 (jamais un 200, jamais le corps vide).
    if (asset.status === 404 && HAS_404) {
      const page = await env.ASSETS.fetch(new Request(new URL("/404.html", url), { method: "GET", headers: request.headers }));
      if (page.ok) asset = new Response(request.method === "HEAD" ? null : page.body, { status: 404, headers: page.headers });
    }
    const response = withHeaders(asset);
    if (response.status === 200) {
      const rule = CACHE.find(([re]) => re.test(url.pathname));
      if (rule) response.headers.set("Cache-Control", rule[1]);
    }
    return response;
  },
};
`;
}
