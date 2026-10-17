// Lanceur de dev : API, puis interface web une fois l'API prête.
// Écrit à la main plutôt que concurrently + npm imbriqués : sous Windows, chaque raccourci
// .cmd ajoute un cmd.exe qui, au Ctrl+C, demande « Terminer le programme de commandes (O/N) ? »
// et se dispute le clavier avec l'invite du terminal. Ici, node lance node directement.
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const tsxCli = require.resolve("tsx/cli");
const viteCli = path.join(path.dirname(require.resolve("vite/package.json")), "bin", "vite.js");
const apiPort = Number(process.env.API_PORT) || 3101;

const COLORS = { api: 34, web: 32 };
const children = new Map();
let stopping = false;

function log(name, line) {
  process.stdout.write(`\x1b[${COLORS[name] ?? 0}m[${name}]\x1b[0m ${line}\n`);
}

function start(name, args, cwd) {
  // stdin ignoré : aucun enfant ne met la console en mode brut, rien ne reste à restaurer.
  const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  children.set(name, child);
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => log(name, line));
  }
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (stopping) return;
    log(name, `arrêté (${signal ?? `code ${code}`}) : arrêt des autres processus`);
    void shutdown(code ?? 1);
  });
}

async function waitForApi(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stopping) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${apiPort}/api/health`);
      if (res.ok) return true;
    } catch {
      // API pas encore à l'écoute
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  // Ctrl+C atteint déjà chaque enfant (même console) ; on relaie pour un arrêt hors console.
  for (const child of children.values()) child.kill("SIGINT");
  const deadline = Date.now() + 5000;
  while (children.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  // Enfant bloqué (watcher) : arbre de processus tué.
  for (const child of children.values()) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      // déjà terminé
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGHUP", () => void shutdown(0));

// Port déjà pris (pile de démo lancée ailleurs) : message clair plutôt qu'un crash EADDRINUSE.
function portOpen(host, port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(800);
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("timeout", () => (socket.destroy(), resolve(false)));
    socket.once("error", () => resolve(false));
  });
}
for (const [name, port] of [["API", apiPort], ["interface (Vite)", 5174]]) {
  if ((await portOpen("127.0.0.1", port)) || (await portOpen("::1", port))) {
    console.error(
      `Port ${port} (${name}) déjà occupé : un hub tourne sans doute déjà (http://localhost:5174).` +
        " Utilisez-la, ou arrêtez-la avant de relancer.",
    );
    process.exit(1);
  }
}
// make dev : contrôle seul, avant la migration (une base ouverte par une pile en cours est verrouillée).
if (process.argv.includes("--check-ports")) process.exit(0);

// --lan : adresse IPv4 du PC sur le réseau local, autorisée par la garde d'origine de l'API
// (DEV_LAN_ORIGIN, transmise aux processus enfants ; ignorée si NODE_ENV=production).
const lan = process.argv.includes("--lan");
let lanUrl = null;
if (lan && process.env.NODE_ENV !== "production") {
  // Box domestique d'abord (192.168.x), avant les cartes virtuelles (Hyper-V, WSL, VPN).
  const rank = (ip) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : 2);
  const ip = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254."))
    .map((a) => a.address)
    .sort((x, y) => rank(x) - rank(y))[0];
  if (ip) {
    lanUrl = `http://${ip}:5174`;
    process.env.DEV_LAN_ORIGIN = lanUrl;
  } else {
    console.error("--lan : aucune adresse du réseau local trouvée, interface accessible sur ce PC seulement.");
  }
}

start("api", [tsxCli, "watch", "--env-file=../../.env", "src/index.ts"], path.join(root, "apps/api"));
if (await waitForApi()) {
  // --lan : l'interface de dev est joignable depuis un téléphone du réseau local (vite --host).
  start("web", [viteCli, ...(lan ? ["--host"] : [])], path.join(root, "apps/web"));
  if (lanUrl) log("web", `téléphone (même Wi-Fi) : ${lanUrl}`);
} else if (!stopping) {
  log("api", `pas de réponse sur :${apiPort}/api/health après 60 s`);
  await shutdown(1);
}
