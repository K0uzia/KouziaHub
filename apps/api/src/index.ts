import { assertSecurityEnv, accessConfig, getApiPort, isProduction } from "@/lib/env.js";
import { enableWal, prisma } from "@/lib/prisma.js";
import { buildApp } from "@/app.js";
import { checkPendingMigrations, checkPrismaClientUpToDate } from "@/lib/migration-check.js";

// Une promesse rejetée sans gestionnaire ne doit jamais arrêter le hub : on journalise.
process.on("unhandledRejection", (reason) => {
  console.error("[process] promesse rejetée non gérée (le serveur continue)", reason);
});

async function main() {
  assertSecurityEnv();
  await enableWal();

  if (!accessConfig()) console.warn("[boot] vérification Cloudflare Access coupée (dev seulement)");

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

  const app = await buildApp();
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
  await app.listen({ port, host: process.env.API_HOST ?? (isProduction() ? "127.0.0.1" : "0.0.0.0") });
  app.log.info(`Hub Kouzia sur :${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
