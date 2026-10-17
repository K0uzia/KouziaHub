/** Corps de robots.txt des versions de travail (et du hub) : rien n'est à explorer. */
export const NOINDEX_ROBOTS = "User-agent: *\nDisallow: /\n";

/** En-têtes ajoutés à toute réponse d'un site client. Pas de CSP : elle casserait le site du client. */
export const SITE_HEADERS: Record<string, string> = {
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
};

/**
 * Programme _worker.js (mode avancé de Pages Functions) injecté par le hub dans chaque déploiement.
 * Les valeurs sont insérées par JSON.stringify : aucune chaîne ne peut sortir de son littéral.
 */
export function buildWorkerScript(hostname: string): string {
  const host = hostname.toLowerCase();
  return `// Généré par le hub Kouzia : ne pas modifier.
const HOST = ${JSON.stringify(host)};
const ROBOTS = ${JSON.stringify(NOINDEX_ROBOTS)};
const HEADERS = ${JSON.stringify(SITE_HEADERS)};

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
    return withHeaders(await env.ASSETS.fetch(request));
  },
};
`;
}
