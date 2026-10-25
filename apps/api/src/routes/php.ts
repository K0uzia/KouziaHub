import type { FastifyPluginAsync } from "fastify";
import type { PhpCtUpdateJob, PhpCtUpdateView, PhpServerStatus } from "@/contract.js";
import { HttpError } from "@/lib/http.js";
import { requireAuth } from "@/lib/auth.js";
import { PhpAgentUnavailableError } from "@/lib/php-agent/client.js";
import { phpCtDigest, updatePhpCt } from "@/lib/php-ct-update.js";
import { prisma } from "@/lib/prisma.js";
import type { Services } from "@/lib/services.js";

/** Serveur des sites PHP (docs/cadrage.md, section 11) : état du CT, lu par son agent. */
export function phpRoutes(services: Services): FastifyPluginAsync {
  // Dernière mise à jour du CT lancée depuis l'interface (une à la fois), rendue avec l'état du serveur.
  let job: PhpCtUpdateJob | null = null;
  return async (app) => {
    app.addHook("onRequest", requireAuth);

    app.get("/api/php/serveur", async (): Promise<PhpServerStatus> => ({ ...(await serverState()), ...(job ? { update: job } : {}) }));

    async function serverState(): Promise<PhpServerStatus> {
      if (!services.phpAgent) return { configured: false };
      try {
        // Somme des plafonds de mémoire des sites (requête + 256 Mo chacun), comparée à la RAM du CT dans la fiche.
        const sites = await prisma.site.findMany({ where: { hosting: "php" }, select: { phpMemoryLimitMb: true } });
        const sitesMemoryMb = sites.reduce((sum, s) => sum + s.phpMemoryLimitMb + 256, 0);
        return { configured: true, reachable: true, state: await services.phpAgent.state(), sitesMemoryMb, scriptsAvailable: await phpCtDigest() };
      } catch (err) {
        if (err instanceof PhpAgentUnavailableError) return { configured: true, reachable: false, error: err.message };
        throw err;
      }
    }

    // Même opération que « hubctl update » : scripts du dépôt du hub envoyés à l'agent, installés, agent relancé.
    app.post("/api/php/serveur/mise-a-jour", async (_request, reply): Promise<{ started: true }> => {
      if (!services.phpAgent) throw new HttpError(503, "Serveur des sites PHP non relié (hubctl secrets php, README section 11.8).", "php_unavailable");
      if (job?.running) throw new HttpError(409, "Mise à jour déjà en cours.", "php_ct_busy");
      job = { running: true, startedAt: new Date().toISOString(), finishedAt: null, ok: null, log: null };
      const current = job;
      void updatePhpCt(services)
        .then((r: PhpCtUpdateView) => Object.assign(current, { ok: r.ok, log: r.ok ? null : r.log }))
        .catch((err: unknown) => Object.assign(current, { ok: false, log: err instanceof Error ? err.message : "échec inattendu" }))
        .finally(() => Object.assign(current, { running: false, finishedAt: new Date().toISOString() }));
      reply.code(202);
      return { started: true };
    });
  };
}
