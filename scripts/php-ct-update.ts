// Mise à jour du CT des sites PHP depuis le dépôt du hub (lancée par « hubctl update », sous le compte du service) :
// scripts envoyés à l'agent, installés, agent relancé. Sans CT PHP relié : rien à faire, code 0.
import { getDataDir } from "@/lib/env.js";
import { phpAgentFromEnv } from "@/lib/php-agent/client.js";
import { phpCtDigest, updatePhpCt } from "@/lib/php-ct-update.js";
import { prisma } from "@/lib/prisma.js";
import { PushService } from "@/lib/push/service.js";

const short = (d: string | null | undefined) => (d ? d.slice(0, 12) : "aucune");

async function main() {
  const phpAgent = phpAgentFromEnv(process.env);
  if (!phpAgent) {
    console.log("Pas de serveur des sites PHP relié : rien à mettre à jour.");
    return;
  }
  // Juste ce qu'il faut (agent, dossier des données, notifications) : pas les services du serveur entier.
  const services = { phpAgent, dataDir: getDataDir(), push: new PushService() };
  const before = await phpAgent.state().catch(() => null);
  const available = await phpCtDigest();
  console.log(`Scripts installés : ${short(before?.scripts?.digest)} ; disponibles : ${short(available)}.`);
  const r = await updatePhpCt(services);
  if (!r.ok) {
    console.log(r.log);
    console.error("Mise à jour du serveur des sites PHP en échec : l'installation d'avant est remise.");
    process.exitCode = 1;
    return;
  }
  const s = r.state!;
  const limits = s.cgroups.result === "ok" ? "effectives" : s.cgroups.result === "echec" ? "non effectives (limites de PHP et du CT seulement)" : "pas encore contrôlées";
  console.log(`Serveur des sites PHP à jour : scripts ${short(r.digest)}, agent ${s.agentVersion}, Alpine ${s.alpine ?? "?"}, PHP ${s.php.join(", ") || "aucun"}.`);
  console.log(`Services : nginx ${s.services.nginx}, MariaDB ${s.services.mariadb}, tunnel ${s.services.tunnel}, pare-feu ${s.services.firewall}. Limites par site : ${limits}.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
