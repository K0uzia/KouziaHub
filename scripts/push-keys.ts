// Clés VAPID des notifications push : écrites dans le .env SI elles sont absentes, jamais remplacées.
// La clé privée n'est jamais affichée. Usage : npm run push:keys -- [--env-file /opt/kouziahub/.env] [--subject mailto:contact@kouzia.com]
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateVapidKeys } from "../apps/api/src/lib/push/vapid";

// Deux formes acceptées : --env-file=<chemin> et --env-file <chemin> (celle de hubctl push-keys).
const arg = (name: string) => {
  const args = process.argv.slice(2);
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const envFile = path.resolve(arg("env-file") ?? ".env");
const subject = arg("subject") ?? "mailto:contact@kouzia.com";

if (!existsSync(envFile)) {
  console.error(`Fichier introuvable : ${envFile}`);
  process.exit(1);
}
const content = readFileSync(envFile, "utf8");
const has = (key: string) => new RegExp(`^${key}=["']?[^"'\\s]+`, "m").test(content);

if (has("VAPID_PUBLIC_KEY") || has("VAPID_PRIVATE_KEY")) {
  console.log("Clés VAPID déjà configurées : ne pas régénérer (les appareils abonnés ne recevraient plus rien).");
  process.exit(0);
}
if (!/^(mailto:|https:\/\/)/.test(subject)) {
  console.error("--subject doit commencer par mailto: ou https://");
  process.exit(1);
}

const keys = generateVapidKeys();
// Les lignes vides du modèle (« VAPID_PUBLIC_KEY= ») sont remplacées ; les absentes sont ajoutées.
const values: Record<string, string> = { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey };
if (!has("VAPID_SUBJECT")) values.VAPID_SUBJECT = subject;
let next = content;
const missing: string[] = [];
for (const [key, value] of Object.entries(values)) {
  const empty = new RegExp(`^${key}=[ \\t]*$`, "m");
  if (empty.test(next)) next = next.replace(empty, `${key}="${value}"`);
  else missing.push(`${key}="${value}"`);
}
if (next !== content) writeFileSync(envFile, next);
if (missing.length > 0) {
  appendFileSync(envFile, `${next.endsWith("\n") ? "" : "\n"}\n# Notifications push (Web Push) : générées par hubctl push-keys. Ne pas régénérer ni versionner.\n${missing.join("\n")}\n`);
}
console.log(`Clés VAPID ajoutées à ${envFile}. Clé publique : ${keys.publicKey}`);
console.log("La clé privée est restée dans le .env (non affichée) : elle fait partie de la sauvegarde du .env.");
console.log("Elle doit aussi être posée en secret du Worker de surveillance (hubctl veille deploy).");
console.log("Si elle est perdue ou changée, chaque appareil devra réactiver les notifications. Redémarrer ensuite le hub.");
