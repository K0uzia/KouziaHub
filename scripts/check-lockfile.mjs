#!/usr/bin/env node
/**
 * Vérifie que package-lock.json contient les binaires de toutes les plateformes.
 * Sous Windows, `npm install` et `npm audit fix` retirent parfois du lockfile les
 * optionalDependencies des autres plateformes (ex. lightningcss-linux-x64-musl) :
 * le build casse alors sur le CT Alpine ou dans Docker.
 * Échoue si une dépendance optionnelle déclarée par un paquet n'a pas d'entrée.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const packages = lock.packages ?? {};

/** Emplacement que npm résout pour `name` depuis le paquet installé en `from`. */
function resolves(from, name) {
  let dir = from;
  while (true) {
    const candidate = `${dir ? `${dir}/` : ""}node_modules/${name}`;
    if (candidate in packages) return true;
    if (!dir) return false;
    const idx = dir.lastIndexOf("/node_modules/");
    dir = idx === -1 ? "" : dir.slice(0, idx);
  }
}

// Paquet de plateforme : il restreint os ou cpu (c'est ce que npm élague à tort).
const isPlatformPkg = (name) => {
  const entry = Object.entries(packages).find(([k]) => k.endsWith(`node_modules/${name}`))?.[1];
  return entry ? Boolean(entry.os || entry.cpu) : /-(linux|darwin|win32|freebsd|android)-/.test(name);
};

const missing = [];
for (const [path, meta] of Object.entries(packages)) {
  for (const name of Object.keys(meta.optionalDependencies ?? {})) {
    if (!isPlatformPkg(name)) continue;
    if (!resolves(path, name)) missing.push(`${path || "(racine)"} -> ${name}`);
  }
}

if (missing.length > 0) {
  console.error("package-lock.json : binaires de plateforme manquants :");
  for (const m of missing) console.error(`  ${m}`);
  console.error(
    "Restaurer les entrées depuis la version précédente du lockfile (git show HEAD:package-lock.json),\n" +
      "sans relancer npm install sous Windows, puis relancer `npm run check:lockfile`.",
  );
  process.exit(1);
}
console.log("package-lock.json : binaires de plateforme présents.");
