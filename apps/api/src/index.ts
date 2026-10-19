import { assertSecurityEnv, accessConfig, getApiPort, isProduction } from "@/lib/env.js";
import { enableWal, prisma } from "@/lib/prisma.js";
import { buildApp } from "@/app.js";
import { getHubPublicHost } from "@/lib/tunnel-host.js";
import { createServices, startBackground } from "@/lib/services.js";
import { intlProblems } from "@/lib/intl-check.js";
import { checkPendingMigrations, checkPrismaClientUpToDate } from "@/lib/migration-check.js";

// Une promesse rejetée sans gestionnaire ne doit jamais arrêter le hub : on journalise.
process.on("unhandledRejection", (reason) => {
  console.error("[process] promesse rejetée non gérée (le serveur continue)", reason);
});

async function main() {
  assertSecurityEnv();
  await enableWal();

  // Le hub démarre quand même : les PDF ne lisent pas Intl (fr-format.ts).
  for (const problem of intlProblems()) console.error(`[boot] ${problem}`);

  if (!accessConfig()) console.log("[boot] accès : login du hub et code à 6 chiffres (sans Cloudflare Access)");
  if (isProduction() && !getHubPublicHost()) console.error("[boot] HUB_PUBLIC_ORIGIN absent : rien n'est servi par le tunnel");

  const stale = checkPrismaClientUpToDate();
  if (stale.length > 0) {
    console.error(
      `[boot] client Prisma pas à jour (absents : ${stale.slice(0, 8).join(", ")}). ` +
        "Lancer `npx prisma generate` (dev : make dev le fait ; prod : hubctl update).",
    );
    if (!isProduction()) process.exit(1);
  }
  try {
    const pending = await checkPendingMigrations();
    if (pending.length > 0) {
      console.error(`[boot] ${pending.length} migration(s) non appliquée(s) : ${pending.join(", ")}. Lancer \`npm run db:deploy\`.`);
      if (!isProduction()) process.exit(1);
    }
  } catch (err) {
    console.warn("[boot] contrôle des migrations impossible", err instanceof Error ? err.message : err);
  }

  const services = createServices();
  if (services.cloudflare.mode === "fake") console.warn("[boot] Cloudflare simulé (pas de CLOUDFLARE_API_TOKEN) : rien n'est créé en vrai");
  const app = await buildApp({ services });
  await startBackground(services);
  const port = getApiPort();

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`[arrêt] ${signal}`);
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    void app
      .close()
      .then(() => prisma.$disconnect())
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => shutdown(signal));

  // Production : derrière cloudflared sur le même CT, écoute locale seulement.
  await app.listen({ port, host: process.env.API_HOST?.trim() || (isProduction() ? "127.0.0.1" : "0.0.0.0") });
  app.log.info(`Hub Kouzia sur :${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
