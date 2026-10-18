// Worker « kouzia-veille » (format module) : points d'entrée signés et passage planifié chaque minute.
// Cadrage : docs/cadrage.md, section 10. Regroupé en un seul fichier par « npm run veille:build ».
import { runCycle } from "./cycle.js";
import { realDeps, type Env, type ExecutionContext, type ScheduledController } from "./env.js";
import { handleFetch } from "./http.js";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleFetch(request, env, realDeps());
  },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runCycle(env, realDeps(), controller.scheduledTime));
  },
};
