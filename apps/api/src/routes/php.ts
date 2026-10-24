import type { FastifyPluginAsync } from "fastify";
import type { PhpServerStatus } from "@/contract.js";
import { requireAuth } from "@/lib/auth.js";
import { PhpAgentUnavailableError } from "@/lib/php-agent/client.js";
import type { Services } from "@/lib/services.js";

/** Serveur des sites PHP (docs/cadrage.md, section 11) : état du CT, lu par son agent. */
export function phpRoutes(services: Services): FastifyPluginAsync {
  return async (app) => {
    app.addHook("onRequest", requireAuth);

    app.get("/api/php/serveur", async (): Promise<PhpServerStatus> => {
      if (!services.phpAgent) return { configured: false };
      try {
        return { configured: true, reachable: true, state: await services.phpAgent.state() };
      } catch (err) {
        if (err instanceof PhpAgentUnavailableError) return { configured: true, reachable: false, error: err.message };
        throw err;
      }
    });
  };
}
