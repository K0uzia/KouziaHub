import type { FastifyPluginAsync } from "fastify";
import type { PhpServerStatus } from "@/contract.js";
import { requireAuth } from "@/lib/auth.js";
import { PhpAgentUnavailableError } from "@/lib/php-agent/client.js";
import { prisma } from "@/lib/prisma.js";
import type { Services } from "@/lib/services.js";

/** Serveur des sites PHP (docs/cadrage.md, section 11) : état du CT, lu par son agent. */
export function phpRoutes(services: Services): FastifyPluginAsync {
  return async (app) => {
    app.addHook("onRequest", requireAuth);

    app.get("/api/php/serveur", async (): Promise<PhpServerStatus> => {
      if (!services.phpAgent) return { configured: false };
      try {
        // Somme des plafonds de mémoire des sites (requête + 256 Mo chacun), comparée à la RAM du CT dans la fiche.
        const sites = await prisma.site.findMany({ where: { hosting: "php" }, select: { phpMemoryLimitMb: true } });
        const sitesMemoryMb = sites.reduce((sum, s) => sum + s.phpMemoryLimitMb + 256, 0);
        return { configured: true, reachable: true, state: await services.phpAgent.state(), sitesMemoryMb };
      } catch (err) {
        if (err instanceof PhpAgentUnavailableError) return { configured: true, reachable: false, error: err.message };
        throw err;
      }
    });
  };
}
