import type { FastifyRequest } from "fastify";

// Journaux : les clés sensibles de la requête sont masquées par principe, pour qu'un journal copié
// ne donne accès à rien. Aucun en-tête n'est journalisé (jeton Access, cookie de session).
const SECRET_QUERY = new Set(["token", "code", "state", "key", "jwt"]);

export function redactUrl(url: string | undefined): string {
  if (!url) return "";
  const q = url.indexOf("?");
  if (q === -1) return url;
  const query = url
    .slice(q + 1)
    .split("&")
    .map((pair) => {
      const key = pair.split("=")[0] ?? "";
      let name = key;
      try {
        name = decodeURIComponent(key);
      } catch {
        // clé mal encodée : comparée telle quelle
      }
      return SECRET_QUERY.has(name.toLowerCase()) ? `${key}=[masqué]` : pair;
    })
    .join("&");
  return `${url.slice(0, q)}?${query}`;
}

/**
 * Adresse d'une requête sans route (404, lien mal tapé, robot) : rien de la requête après « ? », et tout segment qui
 * ressemble à un jeton (16 caractères ou plus, sans espace) masqué. Un jeton collé dans un mauvais lien ne finit
 * jamais en clair dans le journal.
 */
export function redactUnknownUrl(url: string | undefined): string {
  if (!url) return "";
  const q = url.indexOf("?");
  const path = (q === -1 ? url : url.slice(0, q))
    .split("/")
    .map((seg) => (seg.length >= 16 && /^[A-Za-z0-9%_.~+=:-]+$/.test(seg) ? "[masqué]" : seg.slice(0, 64)))
    .join("/");
  return q === -1 ? path : `${path}?[masqué]`;
}

/** Sérialiseur des requêtes du journal Fastify (URL masquée, aucun en-tête). */
export const logSerializers = {
  req(request: FastifyRequest) {
    // Route connue : adresse avec ses paramètres sensibles masqués. Sans route : chemin réduit (redactUnknownUrl).
    const known = Boolean(request.routeOptions?.url);
    return {
      method: request.method,
      url: known ? redactUrl(request.url) : redactUnknownUrl(request.url),
      host: request.headers?.host,
      remoteAddress: request.ip,
    };
  },
};
