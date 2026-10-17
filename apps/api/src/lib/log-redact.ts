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

/** Sérialiseur des requêtes du journal Fastify (URL masquée, aucun en-tête). */
export const logSerializers = {
  req(request: FastifyRequest) {
    return {
      method: request.method,
      url: redactUrl(request.url),
      host: request.headers?.host,
      remoteAddress: request.ip,
    };
  },
};
