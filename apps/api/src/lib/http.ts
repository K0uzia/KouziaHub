import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

/** Message de la limite de débit (json.error). */
export const RATE_LIMITED = "Trop de demandes : réessayez dans quelques minutes.";

/** Erreur métier : statut HTTP et message affichable tel quel par l'interface. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function registerErrorHandler(app: {
  setErrorHandler: (
    handler: (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => void | Promise<void>,
  ) => void;
}): void {
  app.setErrorHandler((error, request, reply) => {
    if (error.statusCode === 429) {
      void reply.code(429).send({ error: RATE_LIMITED });
      return;
    }
    if (error instanceof HttpError) {
      void reply.code(error.statusCode).send({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      return;
    }
    const code = (error as { code?: string }).code;
    if (code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT" || error.statusCode === 413) {
      void reply.code(413).send({ error: "Fichier trop volumineux." });
      return;
    }
    request.log.error({ err: error }, "request error");
    if (error.validation) {
      void reply.code(400).send({ error: "Données invalides" });
      return;
    }
    if (error instanceof ZodError) {
      void reply.code(400).send({ error: error.flatten() });
      return;
    }
    if (code === "P2002") {
      void reply.code(409).send({ error: "Conflit : enregistrement déjà existant" });
      return;
    }
    if (code === "P2025") {
      void reply.code(404).send({ error: "Introuvable" });
      return;
    }
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    void reply.code(status).send({ error: status < 500 && error.message ? error.message : "Erreur serveur" });
  });
}
