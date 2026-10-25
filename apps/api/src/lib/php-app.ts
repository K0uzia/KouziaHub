import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Site } from "@prisma/client";
import type { PhpDbView, PhpEnvView, PhpEnvVar } from "@/contract.js";
import { audit } from "@/lib/audit.js";
import { encrypt } from "@/lib/crypto.js";
import { parisParts } from "@/lib/fr-format.js";
import { HttpError } from "@/lib/http.js";
import { PhpAgentOpError, PhpAgentUnavailableError } from "@/lib/php-agent/client.js";
import { agentOf, envOf } from "@/lib/php-sites.js";
import { prisma } from "@/lib/prisma.js";
import type { Services } from "@/lib/services.js";
// Règles de l'agent, partagées telles quelles : le hub refuse avant d'appeler, l'agent refuse de nouveau.
import { checkEnvVars, dbVars, OpError } from "../../../../scripts/php-ct/agent/sites.mjs";

// Application d'un site PHP (docs/cadrage.md, 11.5, lot P4) : variables d'environnement, base MariaDB, scripts du
// projet, sauvegarde de nuit des bases. Le CT PHP ne garde aucun secret du hub : la sauvegarde est tirée ici.

/** Appel à l'agent, ses erreurs rendues en réponses HTTP lisibles (503 injoignable, sinon le refus de l'agent). */
export async function viaAgent<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PhpAgentUnavailableError) throw new HttpError(503, err.message, "php_unavailable");
    if (err instanceof PhpAgentOpError) throw new HttpError(err.status >= 400 && err.status < 500 ? err.status : 502, err.message, "php_agent");
    throw err;
  }
}

/** Site PHP de l'identifiant, sinon 404 (inconnu) ou 409 (site statique). */
export async function phpSite(id: string): Promise<Site> {
  const site = await prisma.site.findUnique({ where: { id } });
  if (!site) throw new HttpError(404, "Site introuvable.");
  if (site.hosting !== "php") throw new HttpError(409, "Réservé aux sites PHP.", "not_php");
  return site;
}

/** Variables proposées pour un site PHP qui ne les a pas encore. */
function suggestionsFor(site: Site, sitesDomain: string, vars: Record<string, string>): PhpEnvView["suggestions"] {
  const all = [
    { name: "APP_ENV", value: "production", why: "La version de travail se comporte comme en production." },
    { name: "APP_URL", value: `https://${site.slug}.${sitesDomain}`, why: "Adresse de la version de travail." },
    { name: "MAIL_CATCHER", value: "127.0.0.1:1025", why: "E-mails envoyés au capteur du CT, jamais à un vrai destinataire." },
  ];
  return all.filter((s) => !(s.name in vars));
}

export async function envView(services: Services, site: Site): Promise<PhpEnvView> {
  const vars = envOf(site);
  let db: PhpEnvVar[] | null = null;
  try {
    const state = await agentOf(services).dbState(site.slug);
    if (state.exists) db = Object.entries(dbVars(site.slug, "••••••••")).map(([name, value]) => ({ name, value }));
  } catch {
    // Agent injoignable : les variables saisies restent lisibles, sans celles de la base.
    db = null;
  }
  return { vars: Object.entries(vars).map(([name, value]) => ({ name, value })), db, suggestions: suggestionsFor(site, services.sitesDomain, vars) };
}

/** Enregistre les variables : validées (règle de l'agent), posées sur le CT, puis chiffrées dans la base du hub. */
export async function saveEnv(services: Services, site: Site, input: PhpEnvVar[]): Promise<PhpEnvView> {
  const names = input.map((v) => v.name);
  if (new Set(names).size !== names.length) throw new HttpError(400, "Une variable est en double.", "php_env");
  let vars: Record<string, string>;
  try {
    vars = checkEnvVars(Object.fromEntries(input.map((v) => [v.name, v.value])));
  } catch (err) {
    if (err instanceof OpError) throw new HttpError(400, err.message, "php_env");
    throw err;
  }
  await viaAgent(() => agentOf(services).setEnv(site.slug, vars));
  const updated = await prisma.site.update({ where: { id: site.id }, data: { phpEnv: Object.keys(vars).length ? encrypt(JSON.stringify(vars)) : null } });
  // Noms seuls dans le journal, jamais les valeurs.
  await audit({ action: "site.php.env", result: "ok", siteId: site.id, siteSlug: site.slug, detail: Object.keys(vars).join(", ") || "aucune variable" });
  return envView(services, updated);
}

export const dbView = (state: PhpDbView): PhpDbView => ({ exists: state.exists, name: state.name, bytes: state.bytes, tables: state.tables, dumps: state.dumps });

/** Scripts .php de la version servie : hors du dossier public d'abord (outils), puis ceux du dossier public. */
export async function scriptsOf(site: Site): Promise<{ scripts: string[]; publishedVersion: number | null }> {
  if (!site.currentVersionId) return { scripts: [], publishedVersion: null };
  const version = await prisma.version.findUnique({ where: { id: site.currentVersionId }, include: { files: { select: { path: true } } } });
  if (!version) return { scripts: [], publishedVersion: null };
  const pub = site.phpPublicDir ? `${site.phpPublicDir}/` : null;
  const php = version.files.map((f) => f.path).filter((p) => p.endsWith(".php"));
  const outside = php.filter((p) => !pub || !p.startsWith(pub)).sort();
  const inside = php.filter((p) => pub && p.startsWith(pub)).sort();
  return { scripts: [...outside, ...inside].slice(0, 500), publishedVersion: version.number };
}

// --- Sauvegarde de nuit des bases (dossier des données du hub, inclus dans sa sauvegarde chiffrée) ---

export const PHP_DUMPS_KEPT_DAYS = 14;
const DAY_RE = /^\d{4}-\d{2}-\d{2}\.sql\.gz$/;
export const phpDumpsDir = (services: Services, slug: string) => path.join(services.dataDir, "php-dumps", slug);
const dayOf = (now: number) => {
  const p = parisParts(now);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};

/** Sauvegardes de nuit gardées pour un site, la plus récente d'abord. */
export async function nightlyDumps(services: Services, slug: string): Promise<Array<{ day: string; bytes: number }>> {
  const dir = phpDumpsDir(services, slug);
  const names = await readdir(dir).catch(() => [] as string[]);
  const out = [];
  for (const n of names.filter((x) => DAY_RE.test(x)).sort().reverse()) out.push({ day: n.slice(0, 10), bytes: (await stat(path.join(dir, n))).size });
  return out;
}

/** Export de la base de chaque site PHP qui en a une ; 14 jours gardés. Un échec par site est journalisé, sans arrêter les autres. */
export async function backupPhpDatabases(services: Services, now = Date.now()): Promise<{ saved: string[]; failed: string[] }> {
  const agent = services.phpAgent;
  if (!agent) return { saved: [], failed: [] };
  const sites = await prisma.site.findMany({ where: { hosting: "php" }, select: { id: true, slug: true } });
  const saved: string[] = [];
  const failed: string[] = [];
  const day = dayOf(now);
  for (const site of sites) {
    const dir = phpDumpsDir(services, site.slug);
    try {
      if (!(await agent.dbState(site.slug)).exists) continue;
      await mkdir(dir, { recursive: true });
      const part = path.join(dir, `${day}.sql.gz.part`);
      await agent.exportDb(site.slug, part);
      await rename(part, path.join(dir, `${day}.sql.gz`));
      const days = (await readdir(dir)).filter((x) => DAY_RE.test(x)).sort().reverse();
      for (const old of days.slice(PHP_DUMPS_KEPT_DAYS)) await rm(path.join(dir, old), { force: true });
      saved.push(site.slug);
    } catch (err) {
      failed.push(site.slug);
      await rm(path.join(dir, `${day}.sql.gz.part`), { force: true }).catch(() => undefined);
      await audit({ action: "site.php.backup", result: "error", siteId: site.id, siteSlug: site.slug, detail: err instanceof Error ? err.message : "échec" });
    }
  }
  return { saved, failed };
}

/** Déclencheur : une fois par jour de Paris, à partir de 1 h (avant la sauvegarde du hub, vers 2 h). */
export function startPhpBackups(services: Services, intervalMs = 15 * 60_000): NodeJS.Timeout {
  let lastDay: string | null = null;
  let running = false;
  const tick = async () => {
    const now = Date.now();
    if (running || parisParts(now).hour < 1 || lastDay === dayOf(now)) return;
    running = true;
    try {
      await backupPhpDatabases(services, now);
      lastDay = dayOf(now);
    } catch (err) {
      console.error("[sauvegarde des bases PHP] interrompue", err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return timer;
}
