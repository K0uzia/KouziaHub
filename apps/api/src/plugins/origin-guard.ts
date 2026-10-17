import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAllowedOrigins, isProduction } from "@/lib/env.js";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** Hôte d'une origine (« https://hub.kouzia.com » donne « hub.kouzia.com ») ; null si illisible ou opaque. */
function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host || null;
  } catch {
    return null;
  }
}

/**
 * Refuse les mutations venues d'une autre origine (Origin, à défaut Referer, hors liste) : défense en
 * profondeur contre le CSRF, en plus des cookies SameSite=Strict. Même hôte que la requête : acceptée.
 * En production, une mutation sans Origin ni Referer est refusée (un navigateur envoie toujours l'un
 * des deux) ; en dev, tolérée pour curl. Aucune route exemptée : le hub n'a ni webhook ni lien public.
 *
 * fastify-plugin : sans lui, le hook resterait encapsulé dans ce plugin et ne s'appliquerait à aucune route.
 */
async function originGuard(app: FastifyInstance): Promise<void> {
  const allowed = new Set(getAllowedOrigins());

  const accepted = (request: FastifyRequest, origin: string) => {
    if (allowed.has(origin)) return true;
    const host = hostOf(origin);
    return Boolean(host && request.headers.host && host === request.headers.host);
  };

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (SAFE.has(request.method)) return;

    const origin = request.headers.origin;
    if (origin) {
      if (!accepted(request, origin)) await reply.code(403).send({ error: "Origine non autorisée" });
      return;
    }

    const referer = request.headers.referer;
    if (referer) {
      try {
        if (!accepted(request, new URL(referer).origin)) await reply.code(403).send({ error: "Origine non autorisée" });
      } catch {
        await reply.code(403).send({ error: "Origine non autorisée" });
      }
      return;
    }

    if (isProduction()) await reply.code(403).send({ error: "Origine de la requête requise" });
  });
}

export const originGuardPlugin = fp(originGuard, { name: "origin-guard" });
