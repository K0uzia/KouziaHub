// Déploie le Worker de surveillance « kouzia-veille » (hubctl veille deploy, ou depuis le PC :
// npm run veille:deploy -- [--env-file=chemin/.env]).
// Le jeton de déploiement est demandé en saisie masquée, gardé en mémoire le temps du déploiement, jamais
// écrit ni journalisé. Droits : Account > Workers Scripts > Edit et Account > D1 > Edit, rien d'autre.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { SCHEMA_FILE, bundleWorker } from "../workers/veille/tools/bundle.js";
import { DeployError, deployVeille, parseEnv, updateEnvText } from "../workers/veille/tools/deploy.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const envFile = path.resolve(arg("env-file") ?? ".env");

/** Saisie masquée sur un terminal ; sinon une ligne lue sur l'entrée standard (jamais affichée). */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
    if (process.stdin.isTTY) {
      const internal = rl as unknown as { _writeToOutput: (s: string) => void };
      const write = internal._writeToOutput.bind(rl);
      internal._writeToOutput = (s: string) => {
        if (s.startsWith(question)) write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (process.stdin.isTTY) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function main() {
  if (!existsSync(envFile)) throw new DeployError(`Fichier .env introuvable : ${envFile}`);
  console.log("Déploiement de la veille Cloudflare (Worker « kouzia-veille »).");
  console.log("Jeton de déploiement : Account > Workers Scripts > Edit et Account > D1 > Edit, rien d'autre.");
  console.log("Il n'est gardé nulle part : collez-le ci-dessous (rien ne s'affiche).");
  const token = await askHidden("Jeton de déploiement : ");
  if (!/^[A-Za-z0-9_.-]{30,200}$/.test(token)) throw new DeployError(`Jeton invalide (${token.length} caractères reçus).`);

  const envText = readFileSync(envFile, "utf8");
  const script = await bundleWorker();
  const result = await deployVeille(
    { token, env: parseEnv(envText), script, schemaSql: readFileSync(SCHEMA_FILE, "utf8") },
    {
      fetch: (input, init) => fetch(input, init),
      log: (line) => console.log(line),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      randomSecret: () => randomBytes(32).toString("base64url"),
    },
  );
  // Écriture en place : le fichier garde son propriétaire ; droits 600.
  writeFileSync(envFile, updateEnvText(readFileSync(envFile, "utf8"), result.envUpdates));
  try {
    chmodSync(envFile, 0o600);
  } catch {
    // Windows : sans objet.
  }
  console.log(`Veille en place : ${result.workerUrl}`);
  console.log("MONITOR_WORKER_URL écrit dans le .env. Redémarrez le hub pour qu'il l'utilise (hubctl restart).");
  console.log("Le jeton n'a été gardé nulle part. Pour un prochain déploiement, il en faudra un valide (expiration courte conseillée).");
}

main().catch((err) => {
  console.error(err instanceof DeployError ? err.message : "Échec du déploiement (erreur inattendue).");
  process.exitCode = 1;
});
