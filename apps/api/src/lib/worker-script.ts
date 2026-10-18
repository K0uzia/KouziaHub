import { CACHE_RULES } from "@/lib/server-config.js";

/** Corps de robots.txt des versions de travail (et du hub) : rien n'est à explorer. */
export const NOINDEX_ROBOTS = "User-agent: *\nDisallow: /\n";

/** En-têtes ajoutés à toute réponse d'un site client. Pas de CSP : elle casserait le site du client. */
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
export function buildWorkerScript(hostname: string, options: { cacheRules?: boolean } = {}): string {
  const host = hostname.toLowerCase();
  // Cache posé aussi par le worker : _headers ne s'appliquerait peut-être pas derrière env.ASSETS.fetch.
  const cache = options.cacheRules === false ? [] : CACHE_RULES.map((r) => [r.pattern, r.cacheControl]);
  return `// Généré par le hub Kouzia : ne pas modifier.
const HOST = ${JSON.stringify(host)};
const ROBOTS = ${JSON.stringify(NOINDEX_ROBOTS)};
const HEADERS = ${JSON.stringify(SITE_HEADERS)};
const CACHE = ${JSON.stringify(cache)}.map(([pattern, value]) => [new RegExp(pattern, "i"), value]);

// Fichiers de développement jamais servis (403) : segment caché sauf /.well-known/, notes, journaux,
// sauvegardes et cartes de sources. Testé sur le chemin décodé (%2e ne contourne pas la règle).
function isForbidden(pathname) {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {}
  const segments = path.split("/").filter(Boolean);
  if (segments.some((s, i) => s.startsWith(".") && !(i === 0 && s === ".well-known"))) return true;
  return /\\.(md|markdown|log|bak|map|swp)$|~$/i.test(path);
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
    const response = withHeaders(await env.ASSETS.fetch(request));
    if (response.status === 200) {
      const rule = CACHE.find(([re]) => re.test(url.pathname));
      if (rule) response.headers.set("Cache-Control", rule[1]);
    }
    return response;
  },
};
`;
}
