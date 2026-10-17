// Dépendances installées conformes au lockfile, au démarrage de `make dev` (stack arrêtée : les ports
// viennent d'être vérifiés libres). Sinon : `npm ci`, jamais `npm install` (sous Windows, npm install
// retire du lockfile les binaires des autres plateformes, dont ceux du CT Alpine).
// Comparaison : package-lock.json contre node_modules/.package-lock.json (lockfile caché écrit par npm),
// versions des paquets non facultatifs (les binaires d'autres plateformes ne s'installent pas ici).
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = path.join(root, "package-lock.json");
const installedPath = path.join(root, "node_modules", ".package-lock.json");

function differences() {
  if (!existsSync(installedPath)) return ["node_modules absent ou installé sans lockfile"];
  const wanted = JSON.parse(readFileSync(lockPath, "utf8")).packages ?? {};
  const installed = JSON.parse(readFileSync(installedPath, "utf8")).packages ?? {};
  const diffs = [];
  for (const [key, pkg] of Object.entries(wanted)) {
    if (!key.includes("node_modules/") || pkg.optional) continue;
    const got = installed[key];
    if (!got) diffs.push(`${key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length)} manquant`);
    else if (pkg.version && got.version !== pkg.version) diffs.push(`${key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length)} ${got.version} au lieu de ${pkg.version}`);
    if (diffs.length >= 5) break;
  }
  return diffs;
}

const diffs = differences();
if (diffs.length === 0) process.exit(0);
console.log(`[dépendances] node_modules ne correspond pas au lockfile (${diffs.join(", ")}${diffs.length >= 5 ? ", …" : ""}).`);
console.log("[dépendances] Installation propre : npm ci (stack arrêtée, quelques minutes)…");
try {
  execSync("npm ci --no-audit --no-fund", { cwd: root, stdio: "inherit" });
} catch {
  console.error("[dépendances] npm ci a échoué : fermez les éditeurs ou processus qui utilisent node_modules, puis relancez make dev.");
  process.exit(1);
}
const left = differences();
if (left.length > 0) {
  console.error(`[dépendances] toujours différent après npm ci : ${left.join(", ")}`);
  process.exit(1);
}
console.log("[dépendances] à jour.");
