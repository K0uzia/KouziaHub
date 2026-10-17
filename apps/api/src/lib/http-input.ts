import type { FastifyInstance } from "fastify";
import { z } from "zod";

// Entrées de l'URL validées par zod pour TOUTES les routes /api, avant leur code : paramètres de route
// (identifiants, jetons signés, SIREN, noms de fichier de média) et valeurs de la requête. Chaque route
// garde sa propre validation métier ; ce socle refuse ce qui n'est jamais légitime.

/** Paramètre de route : 1 à 256 caractères sûrs (cuid, base64url, point, deux-points, tiret). */
export const routeParam = z.string().min(1).max(256).regex(/^[A-Za-z0-9._~:-]+$/);
/** Schéma partagé des routes /:id. */
export const idParams = z.object({ id: routeParam });

const routeParams = z.record(z.string(), routeParam);
/** Valeur de requête : une seule par clé, 2 000 caractères au plus, sans caractère de contrôle. */
const queryValues = z.record(z.string(), z.string().max(2000).regex(/^[^\u0000-\u001f\u007f]*$/));

export function registerInputGuards(app: FastifyInstance): void {
  app.addHook("preValidation", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (request.params && Object.keys(request.params).length > 0 && !routeParams.safeParse(request.params).success) {
      // Même réponse qu'une route ou une ressource inconnue : rien sur ce qui existe.
      return reply.code(404).send({ error: "Not found" });
    }
    if (request.query && !queryValues.safeParse(request.query).success) {
      return reply.code(400).send({ error: "Paramètres de requête invalides" });
    }
  });
}
