// Opérations de l'agent sur les sites PHP (docs/cadrage.md, sections 11.2 à 11.5, lot P3). L'agent tourne en root :
// chaque paramètre est validé ici, chaque chemin est construit depuis un identifiant contrôlé, aucune commande ne
// passe par un shell. Les actions système passent par « sys » (remplacé dans les tests).
//
// Disposition d'un site, /srv/sites/<slug>/ (root:php-<slug>, 750) :
//   releases/<n>/   versions publiées, à root, lecture seule pour le site (750/640, groupe du site)
//   current         lien vers la version servie (bascule atomique, retour arrière)
//   shared/         dossiers persistants (data/...) et .env (lot P4), au compte du site, 700
//   tmp/ sessions/ logs/   au compte du site (les e-mails capturés sont hors du site : agent/mail.mjs)
//   incoming/       archives reçues, à root, 700
// Compte php-<slug> (UID 20000 à 29999, groupe à lui ; nginx est ajouté à ce groupe pour lire les fichiers).
// PHP-FPM : un maître par site (service OpenRC kouziaphp-site.<slug>), socket /run/kouziaphp/<slug>.sock.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

export const SITE_UID_MIN = 20000;
export const SITE_UID_MAX = 29999;
export const RELEASES_KEPT = 5;
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DIR_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const PHP_RE = /^8\.[2-5]$/;
export const MARIADB_SOCKET = "/run/mysqld/mysqld.sock";
/**
 * Copie sans écraser (lancée par Node sous le compte du site) : fichiers et dossiers de la version absents du
 * dossier persistant. Même résultat partout, quand « cp -n » change de code de sortie selon la version.
 */
export const COPY_MISSING = "require('fs').cpSync(process.argv[1], process.argv[2], { recursive: true, force: false, errorOnExist: false })";
export const DUMPS_KEPT = 5;
/** Page lue pour la vignette : chemin absolu et sa requête, sans espace ni caractère de contrôle. */
export const PAGE_PATH_RE = /^\/[\x21-\x7e]{0,2047}$/;
export const PAGE_MAX_BYTES = 8 * 1024 * 1024;

// --- Variables d'environnement (.env du site, lot P4) ---

/** Variables écrites par l'agent depuis la base du site : jamais saisies (refusées si envoyées). */
export const DB_VARS = ["DB_CONNECTION", "DB_HOST", "DB_SOCKET", "DB_DATABASE", "DB_USERNAME", "DB_USER", "DB_PASSWORD", "DB_DSN"];
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
// Valeurs écrites entre guillemets doubles : ni guillemet, ni barre oblique inverse, ni « $ » (interpolé par
// certaines bibliothèques), ni accent grave, ni retour à la ligne.
const ENV_VALUE_RE = /^[^"\\$`\r\n\0]{0,4096}$/;
/** Clé de paiement réelle (docs/cadrage.md, 11.6) : refusée sur une version de travail. */
export const LIVE_KEY_RE = /\b(?:sk|pk|rk)_live_[A-Za-z0-9]/;

/** Variables saisies, validées : { NOM: valeur }, 100 au plus. */
export function checkEnvVars(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("Variables attendues.");
  const entries = Object.entries(input);
  if (entries.length > 100) throw bad("100 variables au plus.");
  for (const [name, value] of entries) {
    if (!ENV_NAME_RE.test(name)) throw bad(`Nom de variable invalide : « ${name.slice(0, 64)} » (majuscules, chiffres et _).`);
    if (DB_VARS.includes(name)) throw bad(`${name} est rempli d'office depuis la base du site.`);
    if (typeof value !== "string" || !ENV_VALUE_RE.test(value)) throw bad(`Valeur de ${name} refusée : ni guillemet, ni \\, ni $, ni accent grave, ni retour à la ligne (4096 caractères au plus).`);
    if (LIVE_KEY_RE.test(value)) throw bad(`Valeur de ${name} refusée : clé de paiement réelle (live). Une version de travail n'accepte que les clés de test.`);
  }
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

/** Base et compte MariaDB du site (« s_ » et le slug, tirets en _ ; tronqué avec empreinte au-delà de 64). */
export function dbNameOf(slug) {
  const base = `s_${slug.replace(/-/g, "_")}`;
  return base.length <= 64 ? base : `${base.slice(0, 55)}_${createHash("sha256").update(slug).digest("hex").slice(0, 8)}`;
}

/** Variables de la base, d'après le compte du site. */
export function dbVars(slug, password) {
  const name = dbNameOf(slug);
  return {
    DB_CONNECTION: "mysql",
    DB_HOST: "localhost",
    DB_SOCKET: MARIADB_SOCKET,
    DB_DATABASE: name,
    DB_USERNAME: name,
    DB_USER: name,
    DB_PASSWORD: password,
    DB_DSN: `mysql:unix_socket=${MARIADB_SOCKET};dbname=${name};charset=utf8mb4`,
  };
}

/** Texte du .env : variables saisies, puis celles de la base (si elle existe). */
export function envFileText(vars, db) {
  const line = ([k, v]) => `${k}="${v}"`;
  const parts = ["# Écrit par l'agent des sites PHP depuis le hub. Ne pas modifier ici : réglé dans la fiche du site.", ...Object.entries(vars).map(line)];
  if (db) parts.push("", "# Base du site (remplie d'office).", ...Object.entries(db).map(line));
  return `${parts.join("\n")}\n`;
}

export class OpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => new OpError(400, message);

/** Dossier relatif sûr (« public », « web/public ») ; vide autorisé si allowEmpty (racine). */
export function checkRelDir(value, allowEmpty) {
  if (value === "" && allowEmpty) return "";
  if (typeof value !== "string" || value.length > 200) throw bad("Dossier invalide.");
  const segments = value.replace(/\/+$/, "").split("/");
  if (!segments.every((s) => DIR_SEGMENT_RE.test(s) && s !== "." && s !== "..")) throw bad(`Dossier invalide : « ${value} ».`);
  return segments.join("/");
}

/** Réglages d'un site, validés : slug, nom d'hôte attendu, version de PHP installée, dossiers. */
export function checkSiteSpec(input, ctx) {
  if (!input || typeof input !== "object") throw bad("Réglages du site attendus.");
  const slug = input.slug;
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw bad("Identifiant de site invalide.");
  if (input.hostname !== `${slug}.${ctx.domain}`) throw bad(`Nom d'hôte attendu : ${slug}.${ctx.domain}.`);
  if (typeof input.php !== "string" || !PHP_RE.test(input.php) || !ctx.phpInstalled().includes(input.php)) throw bad(`PHP ${input.php} n'est pas installé sur le CT.`);
  const publicDir = checkRelDir(input.publicDir ?? "", true);
  const persistent = Array.isArray(input.persistentDirs) ? input.persistentDirs : [];
  if (persistent.length > 10) throw bad("10 dossiers persistants au plus.");
  const persistentDirs = [...new Set(persistent.map((d) => checkRelDir(d, false)))];
  if (persistentDirs.some((d) => publicDir === "" || d === publicDir || d.startsWith(`${publicDir}/`) || publicDir.startsWith(`${d}/`))) {
    // Un dossier persistant (données, clés) ne doit jamais être servi : hors du dossier public, et le public non vide.
    if (publicDir === "" && persistentDirs.length) throw bad("Avec des dossiers persistants, le dossier public ne peut pas être la racine du projet.");
    throw bad("Un dossier persistant ne peut pas être dans le dossier public (il serait servi).");
  }
  // Dossiers persistants publics (images envoyées par le site) : DANS le dossier public, servis en statique seulement.
  const pub = Array.isArray(input.publicPersistentDirs) ? input.publicPersistentDirs : [];
  if (pub.length > 10) throw bad("10 dossiers persistants publics au plus.");
  const publicPersistentDirs = [...new Set(pub.map((d) => checkRelDir(d, false)))];
  for (const d of publicPersistentDirs) {
    if (publicDir !== "" && !d.startsWith(`${publicDir}/`)) throw bad(`Dossier persistant public hors du dossier public : « ${d} ».`);
    if ([...persistentDirs, ...publicPersistentDirs].some((o) => o !== d && (o.startsWith(`${d}/`) || d.startsWith(`${o}/`)))) throw bad(`Dossiers persistants imbriqués : « ${d} ».`);
  }
  const memoryLimitMb = input.memoryLimitMb ?? 256;
  if (!Number.isInteger(memoryLimitMb) || memoryLimitMb < 64 || memoryLimitMb > 1024) throw bad("Mémoire par requête : de 64 à 1024 Mo.");
  const uploadMaxMb = input.uploadMaxMb ?? 32;
  if (!Number.isInteger(uploadMaxMb) || uploadMaxMb < 1 || uploadMaxMb > 128) throw bad("Taille d'envoi : de 1 à 128 Mo.");
  const cron = input.cron == null ? null : checkCron(input.cron);
  const maxExecutionSec = input.maxExecutionSec ?? 30;
  if (!Number.isInteger(maxExecutionSec) || maxExecutionSec < 5 || maxExecutionSec > 120) throw bad("Durée d'une requête : de 5 à 120 s.");
  return {
    slug,
    hostname: input.hostname,
    php: input.php,
    publicDir,
    persistentDirs,
    publicPersistentDirs,
    memoryLimitMb,
    uploadMaxMb,
    maxExecutionSec,
    cron,
    indexing: input.indexing === true,
    // Sortie réseau (lot P5) : relève IMAP (993) fermée par défaut, HTTPS (443) ouvert par défaut.
    imapOpen: input.imapOpen === true,
    httpsOpen: input.httpsOpen !== false,
  };
}

/** Corps d'une requête accepté : deux fois la taille d'envoi (plusieurs fichiers, champs), 256 Mo au plus. */
export const postMaxMb = (spec) => Math.min(256, 2 * (spec.uploadMaxMb ?? 32));
/** Mémoire du site entier (groupe de contrôle) : une requête à pleine mémoire et 256 Mo pour les autres processus. */
export const siteMemoryMb = (spec) => (spec.memoryLimitMb ?? 256) + 256;

/** Chemin d'un dossier persistant public vu par nginx (relatif au dossier public), avec « / » au début. */
const servedPath = (spec, d) => `/${spec.publicDir === "" ? d : d.slice(spec.publicDir.length + 1)}`;

/** Script du projet à lancer : chemin relatif sûr, fichier .php. */
/** Journaux d'un site lisibles depuis le hub (fichiers fixes de logs/). */
export const LOG_FILES = { php: "php-errors.log", fpm: "php-fpm.log", nginx: "nginx-error.log", cron: "cron-last.out" };

/** Fréquences de la tâche planifiée : ligne de crontab (minute tirée du site, pour étaler) et durée maximale. */
export const CRON_EVERY = {
  "5m": { at: () => "*/5 * * * *", maxSec: 240 },
  "15m": { at: () => "*/15 * * * *", maxSec: 720 },
  "30m": { at: () => "*/30 * * * *", maxSec: 1500 },
  "1h": { at: (m) => `${m} * * * *`, maxSec: 3000 },
  "1d": { at: (m) => `${m} 3 * * *`, maxSec: 7200 },
};

/** Tâche planifiée validée : script relatif .php du projet, fréquence de la liste fermée. */
export function checkCron(input) {
  if (!input || typeof input !== "object") throw bad("Tâche planifiée attendue.");
  if (!Object.hasOwn(CRON_EVERY, input.every)) throw bad("Fréquence de la tâche : 5m, 15m, 30m, 1h ou 1d.");
  return { script: checkScriptPath(input.script), every: input.every };
}

/** Ligne de crontab d'un site (minute fixe tirée du slug pour les tâches horaires et quotidiennes). */
export function cronLine(slug, cron) {
  const minute = Number.parseInt(createHash("sha256").update(slug).digest("hex").slice(0, 4), 16) % 60;
  const e = CRON_EVERY[cron.every];
  return `${e.at(minute)} /usr/local/lib/kouziaphp/cron-run ${slug} ${cron.script} ${e.maxSec}`;
}

export function checkScriptPath(value) {
  if (typeof value !== "string" || !value.endsWith(".php")) throw bad("Script attendu : un fichier .php du projet (chemin relatif).");
  return checkRelDir(value, false);
}

/** UID et GID du compte d'un site, lus dans /etc/passwd. */
export function idsOf(passwdText, user) {
  for (const line of passwdText.split("\n")) {
    const [name, , uid, gid] = line.split(":");
    if (name === user) return { uid: Number(uid), gid: Number(gid) };
  }
  throw new OpError(500, `Compte ${user} absent du CT.`);
}

export const userOf = (slug) => `php-${slug}`;
export const serviceOf = (slug) => `kouziaphp-site.${slug}`;

/** UID déjà attribué au compte du site, sinon le premier libre de la plage. */
export function allocateUid(passwdText, user) {
  const used = new Set();
  for (const line of passwdText.split("\n")) {
    const [name, , uid] = line.split(":");
    if (name === user) return { uid: Number(uid), exists: true };
    const n = Number(uid);
    if (n >= SITE_UID_MIN && n <= SITE_UID_MAX) used.add(n);
  }
  for (let n = SITE_UID_MIN; n <= SITE_UID_MAX; n++) if (!used.has(n)) return { uid: n, exists: false };
  throw new OpError(507, "Plus aucun compte de site disponible sur le CT.");
}

/** Bloc nginx du site : dossier public seul servi, PHP exécuté seulement là, fichiers sensibles refusés. */
/** Chemins du contrôle anti-fuite : chacun refusé par une règle de nginxConf, sans passer par PHP (réponse immédiate). */
export const CHECK_PATHS = ["/.env", "/.git/config", "/composer.json", "/composer.lock", "/vendor/autoload.php"];

export function nginxConf(spec, paths) {
  const root = path.posix.join(paths.sitesDir, spec.slug, "current", spec.publicDir);
  const noindex = spec.indexing ? "" : '    add_header X-Robots-Tag "noindex, nofollow" always;\n';
  const robots = spec.indexing
    ? ""
    : '    location = /robots.txt {\n        add_header X-Robots-Tag "noindex, nofollow" always;\n        default_type text/plain;\n        return 200 "User-agent: *\\nDisallow: /\\n";\n    }\n';
  // « ^~ » : préfixe prioritaire sur toute location regex, donc jamais la règle PHP. Fichiers statiques seulement.
  // Servi DIRECTEMENT depuis shared/ (alias), et aucun lien symbolique suivi : nginx est dans le groupe de chaque
  // site, un lien posé par un site vers le .env d'un autre ne doit jamais être servi (audit du 27/10/2026).
  const uploads = (spec.publicPersistentDirs ?? [])
    .map((d) => {
      const dir = path.posix.join(paths.sitesDir, spec.slug, "shared", d);
      return `    location ^~ ${servedPath(spec, d)}/ {\n        alias ${dir}/;\n        disable_symlinks on from=${dir};\n        location ~ /\\. { return 403; }\n        location ~* \\.(php\\d?|phtml|phar|pht|phps|cgi|pl|py|sh)$ { return 403; }\n    }\n`;
    })
    .join("");
  // Corps accepté : comme post_max_size du pool.
  return `# Généré par l'agent des sites PHP pour ${spec.hostname}. Ne pas modifier : réécrit à chaque réglage.
server {
    listen 127.0.0.1:${paths.nginxPort};
    server_name ${spec.hostname};
    root ${root};
    index index.php index.html;
    client_max_body_size ${postMaxMb(spec)}m;
    access_log ${paths.sitesDir}/${spec.slug}/logs/nginx-access.log;
    error_log ${paths.sitesDir}/${spec.slug}/logs/nginx-error.log warn;
${noindex}${robots}${uploads}
    # Fichiers cachés (.env, .git...) sauf /.well-known/, dépendances et fichiers de projet : jamais servis.
    location ~ /\\.(?!well-known/) { return 403; }
    location ~* (^|/)(vendor|node_modules)/ { return 403; }
    location ~* (^|/)(composer\\.(json|lock)|package(-lock)?\\.json)$ { return 403; }
    location ~* \\.(sql|sqlite|db|bak|log|ini|env|md|sh|dist|lock|ya?ml)$ { return 403; }

    location ~ \\.php$ {
        try_files $fastcgi_script_name =404;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
        fastcgi_param DOCUMENT_ROOT $realpath_root;
        fastcgi_param HTTPS on;
        fastcgi_pass unix:${paths.runDir}/${spec.slug}.sock;
        fastcgi_read_timeout ${(spec.maxExecutionSec ?? 30) + 10}s;
    }

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }
}
`;
}

/** PHP-FPM du site : un maître à lui, sous son compte, enfermé dans son dossier. */
export function fpmConf(spec, paths) {
  const home = path.posix.join(paths.sitesDir, spec.slug);
  const user = userOf(spec.slug);
  return `; Généré par l'agent des sites PHP pour ${spec.hostname}. Ne pas modifier : réécrit à chaque réglage.
[global]
pid = ${paths.runDir}/${spec.slug}.pid
error_log = ${home}/logs/php-fpm.log
daemonize = no

[${spec.slug}]
user = ${user}
group = ${user}
listen = ${paths.runDir}/${spec.slug}.sock
listen.owner = nginx
listen.group = nginx
listen.mode = 0660
pm = ondemand
pm.max_children = 4
pm.process_idle_timeout = 30s
request_terminate_timeout = ${(spec.maxExecutionSec ?? 30) + 5}s
slowlog = ${home}/logs/php-slow.log
request_slowlog_timeout = 5s
catch_workers_output = yes
clear_env = yes
php_admin_value[open_basedir] = ${home}/
; Limites en php_admin_value : ni ini_set ni le .user.ini du projet ne peuvent les changer.
php_admin_value[memory_limit] = ${spec.memoryLimitMb ?? 256}M
php_admin_value[max_execution_time] = ${spec.maxExecutionSec ?? 30}
php_admin_value[upload_max_filesize] = ${spec.uploadMaxMb ?? 32}M
php_admin_value[post_max_size] = ${postMaxMb(spec)}M
; Base du site : MariaDB par le socket local seulement (localhost = socket pour PDO et mysqli).
php_admin_value[pdo_mysql.default_socket] = ${MARIADB_SOCKET}
php_admin_value[mysqli.default_socket] = ${MARIADB_SOCKET}
php_admin_value[sys_temp_dir] = ${home}/tmp
php_admin_value[upload_tmp_dir] = ${home}/tmp
php_admin_value[session.save_path] = ${home}/sessions
php_admin_value[error_log] = ${home}/logs/php-errors.log
php_admin_flag[log_errors] = on
php_admin_value[sendmail_path] = /usr/local/lib/kouziaphp/mail-capture ${spec.slug}
`;
}

/** Service OpenRC du site (lien vers le script commun) et ses limites (si les cgroups sont effectifs). */
export function serviceConf(spec, limits) {
  const lines = [`KP_PHP="${spec.php.replace(".", "")}"`, `KP_SITE="${spec.slug}"`];
  if (limits) lines.push('rc_cgroup_settings="', `memory.max ${siteMemoryMb(spec)}M`, "memory.swap.max 0", "cpu.max 100000 100000", "pids.max 64", '"');
  return `# Généré par l'agent des sites PHP pour ${spec.hostname}.\n${lines.join("\n")}\n`;
}

/** Contrôle d'une liste d'entrées d'archive (« tar -tvf ») : fichiers et dossiers seulement, chemins relatifs sûrs. */
export function checkArchiveListing(text) {
  const names = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const type = line[0];
    if (type !== "-" && type !== "d") throw bad("Archive refusée : lien ou fichier spécial.");
    const name = line.split(/\s+/).slice(5).join(" ").replace(/^\.\//, "").replace(/\/$/, "");
    if (!name) continue;
    if (name.startsWith("/") || name.split("/").some((s) => s === ".." || s === "")) throw bad("Archive refusée : chemin hors du site.");
    names.push(name);
  }
  return names;
}

/**
 * Opérations sur les sites. ctx : { paths, domain, phpInstalled(), limitsEffective(), httpStatus(host, path), sys }.
 * sys : run(file, args) -> { code, stdout, stderr } ; readFile, writeFile (atomique), mkdir, rm, symlink, rename,
 * readdir, chown, chmod, exists, cp (copie récursive).
 */
export function siteOperations(ctx) {
  const { paths, sys } = ctx;
  const siteDir = (slug) => path.posix.join(paths.sitesDir, slug);

  const run = async (file, args, what) => {
    const r = await sys.run(file, args);
    if (r.code !== 0) throw new OpError(500, `${what} : échec (${(r.stderr || "").trim().slice(0, 200) || `code ${r.code}`}).`);
    return r;
  };

  const known = async (slug) => {
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw bad("Identifiant de site invalide.");
    if (!(await sys.exists(path.posix.join(paths.confDir, "sites", `${slug}.json`)))) throw new OpError(404, "Site inconnu sur le CT.");
    return JSON.parse(await sys.readFile(path.posix.join(paths.confDir, "sites", `${slug}.json`)));
  };

  /** Écrit les configurations du site ; vrai si celles de PHP (pool, limites du service) ont changé. */
  async function writeConfigs(spec) {
    await sys.writeFile(path.posix.join(paths.confDir, "sites", `${spec.slug}.json`), `${JSON.stringify(spec, null, 2)}\n`, 0o600);
    let phpChanged = false;
    for (const [file, text] of [
      [path.posix.join(paths.confDir, "fpm", `${spec.slug}.conf`), fpmConf(spec, paths)],
      [path.posix.join(paths.confdDir, serviceOf(spec.slug)), serviceConf(spec, ctx.limitsEffective())],
    ]) {
      const before = (await sys.exists(file)) ? await sys.readFile(file) : null;
      if (before !== text) {
        phpChanged = true;
        await sys.writeFile(file, text, 0o644);
      }
    }
    const conf = path.posix.join(paths.nginxSitesDir, `${spec.slug}.conf`);
    const off = `${conf}.off`;
    // Site coupé : sa configuration reste désactivée (.off) jusqu'au rallumage.
    const target = (await sys.exists(off)) ? off : conf;
    await sys.writeFile(target, nginxConf(spec, paths), 0o644);
    return phpChanged;
  }

  async function reloadNginx() {
    await run("/usr/sbin/nginx", ["-t"], "Configuration nginx");
    await run("/sbin/rc-service", ["nginx", "reload"], "Rechargement de nginx");
  }

  // --- Base et .env du site (lot P4). Le mot de passe MariaDB est généré ici et ne quitte jamais le CT : il est
  // gardé dans /etc/kouziaphp/sites/<slug>.db.cnf (root, 600) et passé aux commandes par ce fichier, jamais en
  // argument (visible des autres comptes dans la liste des processus).
  const dbCnf = (slug) => path.posix.join(paths.confDir, "sites", `${slug}.db.cnf`);
  const envJson = (slug) => path.posix.join(paths.confDir, "sites", `${slug}.env.json`);
  const envFile = (slug) => path.posix.join(siteDir(slug), ".env");
  const dumpsDir = (slug) => path.posix.join(siteDir(slug), "dumps");

  async function dbPassword(slug) {
    if (!(await sys.exists(dbCnf(slug)))) return null;
    return /^password=(\S+)$/m.exec(await sys.readFile(dbCnf(slug)))?.[1] ?? null;
  }

  /** SQL en root (authentification par socket : l'agent est root), texte passé sur l'entrée standard. */
  async function rootSql(sql, what) {
    const r = await sys.runIo("/usr/bin/mariadb", ["--batch", "--skip-column-names"], { input: sql, timeoutMs: 60_000 });
    if (r.code !== 0) throw new OpError(500, `${what} : échec (${(r.stderr || "").trim().slice(0, 200) || `code ${r.code}`}).`);
    return r.stdout;
  }

  /** .env du site : root:php-<slug>, 440 (le site le lit, ne peut pas le changer), hors du dossier public. */
  async function writeEnv(slug) {
    const vars = (await sys.exists(envJson(slug))) ? JSON.parse(await sys.readFile(envJson(slug))) : {};
    const password = await dbPassword(slug);
    await sys.writeFile(envFile(slug), envFileText(vars, password ? dbVars(slug, password) : null), 0o440);
    await sys.chown(envFile(slug), "root", userOf(slug));
  }

  /** Lien .env à la racine d'une version (le projet le lit à côté de son dossier public). */
  async function linkEnv(slug, releaseDir) {
    const link = path.posix.join(releaseDir, ".env");
    await sys.rm(link);
    await sys.symlink(envFile(slug), link);
  }

  /** Dump compressé de la base du site, avec le compte du site (jamais root : il ne voit que sa base). */
  async function dumpTo(slug, file) {
    const r = await sys.runIo(
      "/usr/bin/mariadb-dump",
      [`--defaults-extra-file=${dbCnf(slug)}`, "--single-transaction", "--no-tablespaces", "--routines", "--triggers", dbNameOf(slug)],
      { outputFile: file, gzip: true, timeoutMs: 30 * 60_000 },
    );
    if (r.code !== 0) {
      await sys.rm(file);
      throw new OpError(500, `Export de la base : échec (${(r.stderr || "").trim().slice(0, 200) || `code ${r.code}`}).`);
    }
  }

  /**
   * Import d'un fichier SQL (.sql ou .sql.gz) avec le compte du site : il ne peut toucher que sa base. Client en
   * --sandbox : le client tourne en root, aucune commande cliente du fichier (\! shell, source...) ne s'exécute
   * (fichier envoyé, ou dump d'une base que le site contrôle ; audit du 27/10/2026).
   */
  async function importFrom(slug, file, gz) {
    const r = await sys.runIo("/usr/bin/mariadb", [`--defaults-extra-file=${dbCnf(slug)}`, "--sandbox", dbNameOf(slug)], { inputFile: file, gunzip: gz, timeoutMs: 30 * 60_000 });
    if (r.code !== 0) throw new OpError(422, `Import refusé par MariaDB : ${(r.stderr || "").trim().slice(0, 300) || `code ${r.code}`}.`);
  }

  async function createDatabase(slug, password) {
    const name = dbNameOf(slug);
    await rootSql(
      [
        `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
        `CREATE USER IF NOT EXISTS '${name}'@'localhost' IDENTIFIED BY '${password}' WITH MAX_USER_CONNECTIONS 10;`,
        `ALTER USER '${name}'@'localhost' IDENTIFIED BY '${password}' WITH MAX_USER_CONNECTIONS 10;`,
        `GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${name}'@'localhost';`,
        "FLUSH PRIVILEGES;",
      ].join("\n"),
      "Création de la base",
    );
  }

  /**
   * Reprise d'un site publié par un agent plus ancien : il créait EN ROOT les dossiers parents d'un dossier
   * persistant (shared/public/, shared/public/assets/...), où le compte du site ne peut plus rien créer. Chaque
   * dossier existant de shared/<dossier> (parents compris) est rendu au compte du site, sans suivre aucun lien :
   * un lien posé par le site arrête tout (root ne doit jamais agir ailleurs). Le .env du site n'est pas dans shared/.
   */
  async function repairShared(slug, dir) {
    const user = userOf(slug);
    const segments = dir.split("/");
    for (let i = 1; i <= segments.length; i++) {
      const p = path.posix.join(siteDir(slug), "shared", ...segments.slice(0, i));
      const st = await sys.run("/bin/stat", ["-c", "%U %F", p]);
      if (st.code !== 0) return; // absent : le compte du site le créera (son parent lui appartient).
      const [owner, ...kind] = st.stdout.trim().split(" ");
      const type = kind.join(" ");
      if (type === "symbolic link") throw new OpError(409, `Dossier persistant : « ${p} » est un lien, refusé (le site ne doit pas rediriger ses dossiers persistants).`);
      if (type !== "directory") throw new OpError(409, `Dossier persistant : « ${p} » n'est pas un dossier.`);
      if (owner !== user) {
        await run("/bin/chown", ["-h", `${user}:${user}`, p], "Reprise du dossier persistant");
        await run("/bin/chmod", ["750", p], "Reprise du dossier persistant");
      }
    }
  }

  // --- Tâche planifiée (lot P5) : crontab du compte du site, lue par crond (BusyBox) ---
  const crontabsDir = paths.crontabsDir ?? "/etc/crontabs";

  /** Pose la crontab du site (tâche réglée et site allumé) ou la retire ; crond est prévenu par cron.update. */
  async function writeCron(spec, enabled) {
    const file = path.posix.join(crontabsDir, userOf(spec.slug));
    if (spec.cron && enabled) {
      await sys.writeFile(file, `# Écrit par l'agent des sites PHP (tâche planifiée du site, réglée dans le hub).\n${cronLine(spec.slug, spec.cron)}\n`, 0o600);
    } else {
      await sys.rm(file);
    }
    const update = path.posix.join(crontabsDir, "cron.update");
    const prev = (await sys.exists(update)) ? await sys.readFile(update) : "";
    await sys.writeFile(update, `${prev}${userOf(spec.slug)}\n`, 0o600);
  }

  // --- Sortie réseau par site (lot P5) : ensembles imap_open et https_closed du pare-feu du CT (firewall.sh) ---
  const netDir = path.posix.join(paths.confDir, "net");

  /**
   * Listes d'UID recalculées depuis tous les sites : 993 ouvert pour un site allumé dont la relève IMAP est activée ;
   * 443 fermé pour un site qui l'a fermé ou qui est coupé. Pare-feu reposé seulement si une liste change.
   */
  async function writeNetwork() {
    const passwd = await sys.readFile(paths.passwdFile);
    const sitesConf = path.posix.join(paths.confDir, "sites");
    const names = await sys.readdir(sitesConf).catch(() => []);
    const imap = [];
    const closed = [];
    for (const name of names.filter((n) => /^[a-z0-9-]+\.json$/.test(n) && !/\.(db|env)\.json$/.test(n)).sort()) {
      const spec = JSON.parse(await sys.readFile(path.posix.join(sitesConf, name)));
      if (!SLUG_RE.test(spec.slug ?? "")) continue;
      const line = passwd.split("\n").find((l) => l.startsWith(`${userOf(spec.slug)}:`));
      if (!line) continue;
      const uid = line.split(":")[2];
      const enabled = !(await sys.exists(path.posix.join(paths.nginxSitesDir, `${spec.slug}.conf.off`)));
      if (enabled && spec.imapOpen === true) imap.push(uid);
      if (!enabled || spec.httpsOpen === false) closed.push(uid);
    }
    let changed = false;
    for (const [file, uids] of [
      ["imap-open", imap],
      ["https-closed", closed],
    ]) {
      const p = path.posix.join(netDir, file);
      const text = uids.map((u) => `${u}\n`).join("");
      if (((await sys.exists(p)) ? await sys.readFile(p) : "") === text) continue;
      await sys.writeFile(p, text, 0o600);
      changed = true;
    }
    if (changed) await run("/bin/sh", [paths.firewallScript ?? "/usr/local/lib/kouziaphp/firewall.sh"], "Pare-feu du CT (sortie réseau des sites)");
  }

  /** Valeurs à masquer dans ce que le hub affiche (variables du .env, mot de passe de la base). */
  async function secretsOf(slug) {
    const vars = (await sys.exists(envJson(slug))) ? Object.values(JSON.parse(await sys.readFile(envJson(slug)))) : [];
    return [...vars, (await dbPassword(slug)) ?? ""].filter((v) => v.length >= 6);
  }
  const scrubWith = (secrets) => (text) => secrets.reduce((t, v) => t.split(v).join("••••"), text);

  /** Fin d'un fichier de journal du site, lue SOUS SON COMPTE (un lien qu'il y aurait posé ne mène root nulle part). */
  async function tailAsSite(slug, file, lines) {
    const ids = idsOf(await sys.readFile(paths.passwdFile), userOf(slug));
    const r = await sys.runIo("/usr/bin/tail", ["-n", String(lines), file], { uid: ids.uid, gid: ids.gid, timeoutMs: 10_000, maxOutput: 512 * 1024 });
    return r.code === 0 ? r.stdout : "";
  }

  /** Commande sous le compte du site (UID et GID du compte, groupes de root retirés), échec rendu lisible. */
  async function asSite(slug, file, args, what) {
    const ids = idsOf(await sys.readFile(paths.passwdFile), userOf(slug));
    const r = await sys.runIo(file, args, { uid: ids.uid, gid: ids.gid, timeoutMs: 10 * 60_000 });
    if (r.code !== 0) throw new OpError(500, `${what} : échec (${(r.stderr || "").trim().slice(0, 200) || `code ${r.code}`}).`);
  }

  const versionOf = (n) => {
    if (!Number.isInteger(n) || n < 1 || n > 1_000_000) throw bad("Numéro de version invalide.");
    return n;
  };

  const ops = {
    /**
     * Fichier où écrire un envoi reçu d'un site connu (incoming/, à root), nommé par le nonce de la requête.
     * kind : « version » (archive tar.gz), « sql » ou « sqlgz » (import de base).
     */
    async incomingFile(slug, nonce, kind = "version") {
      const spec = await known(slug);
      if (!/^[0-9a-f]{32}$/.test(nonce)) throw bad("Nonce invalide.");
      const ext = { version: "tar.gz", sql: "sql", sqlgz: "sql.gz" }[kind];
      if (!ext) throw bad("Type d'envoi inconnu.");
      return path.posix.join(siteDir(spec.slug), "incoming", `${nonce}.${ext}`);
    },

    /** Crée ou met à jour un site (rejouable). */
    async upsert(input) {
      const spec = checkSiteSpec(input, ctx);
      const user = userOf(spec.slug);
      const { uid, exists } = allocateUid(await sys.readFile(paths.passwdFile), user);
      if (!exists) {
        await run("/usr/sbin/adduser", ["-D", "-H", "-h", siteDir(spec.slug), "-s", "/sbin/nologin", "-u", String(uid), user], "Création du compte du site");
        await run("/usr/sbin/addgroup", ["nginx", user], "Accès de nginx aux fichiers du site");
      }
      const home = siteDir(spec.slug);
      await sys.mkdir(home, 0o750);
      await sys.chown(home, "root", user);
      // [dossier, propriétaire, groupe, droits] : le site lit releases/ (groupe) sans pouvoir y écrire.
      for (const [dir, owner, group, mode] of [
        ["releases", "root", user, 0o750],
        ["incoming", "root", "root", 0o700],
        ["dumps", "root", "root", 0o700],
        // 750 : nginx (groupe du site) y traverse vers les dossiers persistants publics ; les privés restent en 700.
        ["shared", user, user, 0o750],
        ["tmp", user, user, 0o700],
        ["sessions", user, user, 0o700],
        ["logs", user, user, 0o750],
      ]) {
        const p = path.posix.join(home, dir);
        await sys.mkdir(p, mode);
        await sys.chown(p, owner, group);
      }
      const phpChanged = await writeConfigs(spec);
      await writeCron(spec, !(await sys.exists(path.posix.join(paths.nginxSitesDir, `${spec.slug}.conf.off`))));
      if (!(await sys.exists(envFile(spec.slug)))) await writeEnv(spec.slug);
      // Réglages de PHP changés (limites, mémoire du groupe de contrôle) : appliqués par un redémarrage, seulement là.
      if (phpChanged && (await sys.run("/sbin/rc-service", [serviceOf(spec.slug), "status"])).code === 0) {
        await run("/sbin/rc-service", [serviceOf(spec.slug), "restart"], "Redémarrage de PHP (réglages changés)");
      }
      const init = path.posix.join(paths.initDir, serviceOf(spec.slug));
      if (!(await sys.exists(init))) await sys.symlink(path.posix.join(paths.initDir, "kouziaphp-site"), init);
      await reloadNginx();
      await writeNetwork();
      return { slug: spec.slug, uid, created: !exists };
    },

    /**
     * Reçoit l'archive d'une version (déjà écrite dans incoming/ par le serveur, empreinte vérifiée), la contrôle
     * puis l'extrait dans releases/<n>/, à root, lecture seule pour le site.
     */
    async receive(slug, n, archivePath) {
      const spec = await known(slug);
      if (!Number.isInteger(n) || n < 1 || n > 1_000_000) throw bad("Numéro de version invalide.");
      const listing = await run("/bin/tar", ["-tvzf", archivePath], "Lecture de l'archive");
      checkArchiveListing(listing.stdout);
      const dir = path.posix.join(siteDir(spec.slug), "releases", String(n));
      await sys.rm(dir);
      await sys.mkdir(dir, 0o750);
      // -o : propriétaire de l'archive ignoré (BusyBox et GNU tar) ; droits reposés juste après.
      await run("/bin/tar", ["-xzof", archivePath, "-C", dir], "Extraction de la version");
      await run("/bin/chown", ["-R", `root:${userOf(spec.slug)}`, dir], "Droits de la version");
      await run("/bin/chmod", ["-R", "u=rwX,g=rX,o=", dir], "Droits de la version");
      await sys.rm(archivePath);
      return { slug: spec.slug, version: n };
    },

    /** Publie une version reçue : dossiers persistants reliés, bascule atomique de current, PHP rechargé. */
    async publish(slug, n) {
      const spec = await known(slug);
      const home = siteDir(spec.slug);
      const dir = path.posix.join(home, "releases", String(n));
      if (!Number.isInteger(n) || !(await sys.exists(dir))) throw new OpError(404, "Version absente du CT : à renvoyer.");
      const persistent = [...spec.persistentDirs.map((d) => [d, false]), ...(spec.publicPersistentDirs ?? []).map((d) => [d, true])];
      for (const [d, served] of persistent) {
        const shared = path.posix.join(home, "shared", d);
        const inRelease = path.posix.join(dir, d);
        // À chaque publication, les fichiers de la version absents du dossier persistant y sont ajoutés ; un fichier
        // déjà présent (envoyé ou modifié par le site) n'est jamais remplacé. Une première publication sans ces
        // fichiers (page d'attente) ne fige donc rien. Tout se fait SOUS LE COMPTE DU SITE : root ne touche jamais
        // un chemin que le site contrôle (un lien qu'il y aurait posé ne mène pas root ailleurs).
        await repairShared(spec.slug, d);
        await asSite(spec.slug, "/bin/mkdir", ["-p", shared], "Dossier persistant");
        // Publication reprise après une interruption : le dossier de la version est déjà le lien vers shared/
        // (releases/ est à root, le site n'y pose rien). Le recopier serait copier shared/ sur lui-même.
        const linked = (await sys.run("/bin/stat", ["-c", "%F", inRelease])).stdout.trim().endsWith("symbolic link");
        if (!linked && (await sys.exists(inRelease))) await asSite(spec.slug, process.execPath, ["-e", COPY_MISSING, inRelease, shared], "Fichiers du dossier persistant");
        // Privé (données, clés) : au seul compte du site. Public : lisible de nginx (groupe), jamais exécuté.
        await asSite(spec.slug, "/bin/chmod", ["-R", served ? "u=rwX,g=rX,o=" : "u=rwX,go=", shared], "Droits du dossier persistant");
        await sys.rm(inRelease);
        await sys.mkdir(path.posix.dirname(inRelease), 0o750);
        await sys.symlink(shared, inRelease);
      }
      await linkEnv(spec.slug, dir);
      const tmp = path.posix.join(home, `current.${n}.tmp`);
      await sys.rm(tmp);
      await sys.symlink(path.posix.join("releases", String(n)), tmp);
      await sys.rename(tmp, path.posix.join(home, "current"));
      const svc = serviceOf(spec.slug);
      const running = (await sys.run("/sbin/rc-service", [svc, "status"])).code === 0;
      if (running) await run("/sbin/rc-service", [svc, "reload"], "Rechargement de PHP");
      else if (!(await sys.exists(path.posix.join(paths.nginxSitesDir, `${spec.slug}.conf.off`)))) {
        await run("/sbin/rc-service", [svc, "start"], "Démarrage de PHP");
        await sys.run("/sbin/rc-update", ["add", svc, "default"]);
      }
      // Versions gardées : les RELEASES_KEPT plus récentes, la servie toujours comprise.
      const all = (await sys.readdir(path.posix.join(home, "releases"))).filter((x) => /^\d+$/.test(x)).map(Number).sort((a, b) => b - a);
      for (const old of all.slice(RELEASES_KEPT)) if (old !== n) await sys.rm(path.posix.join(home, "releases", String(old)));
      return { slug: spec.slug, current: n };
    },

    /** Coupe le site (configuration nginx désactivée, PHP arrêté) ou le rallume. */
    async setEnabled(slug, enabled) {
      const spec = await known(slug);
      const conf = path.posix.join(paths.nginxSitesDir, `${spec.slug}.conf`);
      const off = `${conf}.off`;
      const svc = serviceOf(spec.slug);
      if (enabled) {
        if (await sys.exists(off)) await sys.rename(off, conf);
        if (await sys.exists(path.posix.join(siteDir(spec.slug), "current"))) {
          await run("/sbin/rc-service", [svc, "start"], "Démarrage de PHP");
          await sys.run("/sbin/rc-update", ["add", svc, "default"]);
        }
      } else {
        if (await sys.exists(conf)) await sys.rename(conf, off);
        await sys.run("/sbin/rc-service", [svc, "stop"]);
        await sys.run("/sbin/rc-update", ["del", svc, "default"]);
      }
      await reloadNginx();
      // Tâche planifiée coupée avec le site, remise au rallumage.
      await writeCron(spec, enabled);
      // Relève IMAP et HTTPS refermées quand le site est coupé, rouvertes selon ses réglages au rallumage.
      await writeNetwork();
      return { slug: spec.slug, enabled };
    },

    /**
     * Une ressource du site lue sur nginx local, sous son nom (GET seulement), pour la vignette : le navigateur du hub
     * n'a aucun réseau et reçoit les pages par le hub. Ni cookie ni corps envoyés ; réponse de 8 Mio au plus.
     */
    async page(slug, reqPath) {
      const spec = await known(slug);
      if (typeof reqPath !== "string" || !PAGE_PATH_RE.test(reqPath)) throw bad("Chemin de page invalide.");
      if (typeof ctx.httpGet !== "function") throw new OpError(503, "Lecture des pages indisponible sur cet agent.");
      const r = await ctx.httpGet(spec.hostname, reqPath, PAGE_MAX_BYTES);
      return { status: r.status, contentType: r.contentType ?? null, location: r.location ?? null, body: r.body.toString("base64") };
    },

    /**
     * Contrôle anti-fuite (docs/cadrage.md, 11.8) : nginx local, sous le nom du site, ne doit servir ni secrets ni
     * dépendances. Chaque chemin doit répondre 403 ou 404. Les dossiers persistants ne sont pas sondés : hors du
     * dossier public par construction (checkSiteSpec), un chemin vers eux tombe dans index.php (lent, et 200).
     */
    async check(slug) {
      const spec = await known(slug);
      const probes = CHECK_PATHS;
      // En parallèle : chaque sonde est bornée par httpStatus (2 s), le contrôle entier aussi.
      const results = await Promise.all(probes.map(async (p) => ({ path: p, status: await ctx.httpStatus(spec.hostname, p) })));
      // Dossiers persistants publics : un .php déposé par le site ne doit jamais s'exécuter (sonde posée, demandée, retirée).
      for (const d of spec.publicPersistentDirs ?? []) {
        const shared = path.posix.join(siteDir(spec.slug), "shared", d);
        if (!(await sys.exists(shared))) continue;
        const name = `kouzia-sonde-${randomBytes(8).toString("hex")}.php`;
        const file = path.posix.join(shared, name);
        await sys.writeFile(file, "<?php echo 'EXECUTE';\n", 0o644);
        try {
          results.push({ path: `${servedPath(spec, d)}/${name}`, status: await ctx.httpStatus(spec.hostname, `${servedPath(spec, d)}/${name}`) });
        } finally {
          await sys.rm(file);
        }
      }
      const leaks = results.filter((r) => r.status !== 403 && r.status !== 404);
      return { slug: spec.slug, ok: leaks.length === 0, results };
    },

    /** Tâche planifiée : réglage, ligne de crontab, dernier passage (début, durée, code) et fin de sa sortie (masquée). */
    async cronState(slug) {
      const spec = await known(slug);
      const logs = path.posix.join(siteDir(spec.slug), "logs");
      let last = null;
      try {
        last = JSON.parse(await tailAsSite(spec.slug, path.posix.join(logs, "cron-last.json"), 1));
      } catch {
        last = null;
      }
      const output = scrubWith(await secretsOf(spec.slug))(await tailAsSite(spec.slug, path.posix.join(logs, "cron-last.out"), 200));
      const enabled = !(await sys.exists(path.posix.join(paths.nginxSitesDir, `${spec.slug}.conf.off`)));
      return {
        slug: spec.slug,
        cron: spec.cron ?? null,
        line: spec.cron ? cronLine(spec.slug, spec.cron) : null,
        maxSec: spec.cron ? CRON_EVERY[spec.cron.every].maxSec : null,
        active: Boolean(spec.cron) && enabled,
        last,
        output,
      };
    },

    /** Journal du site, les dernières lignes : erreurs PHP, PHP-FPM, erreurs nginx, sortie de la tâche planifiée. */
    async logs(slug, kind, lines) {
      const spec = await known(slug);
      const file = LOG_FILES[kind];
      if (!file) throw bad("Journal inconnu : php, fpm, nginx ou cron.");
      if (!Number.isInteger(lines) || lines < 1 || lines > 2000) throw bad("Nombre de lignes : de 1 à 2000.");
      const text = await tailAsSite(spec.slug, path.posix.join(siteDir(spec.slug), "logs", file), lines);
      return { slug: spec.slug, kind, text: scrubWith(await secretsOf(spec.slug))(text) };
    },

    /** Variables saisies dans le hub : gardées (root, 600) et réécrites dans le .env avec celles de la base. */
    async setEnv(slug, input) {
      const spec = await known(slug);
      const vars = checkEnvVars(input);
      await sys.writeFile(envJson(spec.slug), `${JSON.stringify(vars)}\n`, 0o600);
      await writeEnv(spec.slug);
      return { slug: spec.slug, names: Object.keys(vars) };
    },

    /** État de la base : présente ou non, taille, tables, dumps gardés (numéros de version). */
    async dbState(slug) {
      const spec = await known(slug);
      const exists = await sys.exists(dbCnf(spec.slug));
      const dumps = (await sys.exists(dumpsDir(spec.slug)))
        ? (await sys.readdir(dumpsDir(spec.slug))).map((f) => /^(\d+)\.sql\.gz$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => b - a)
        : [];
      if (!exists) return { slug: spec.slug, exists: false, name: null, bytes: 0, tables: 0, dumps };
      const name = dbNameOf(spec.slug);
      const [bytes, tables] = (
        await rootSql(`SELECT COALESCE(SUM(data_length + index_length), 0), COUNT(*) FROM information_schema.tables WHERE table_schema = '${name}';`, "Lecture de la base")
      )
        .trim()
        .split(/\s+/)
        .map(Number);
      return { slug: spec.slug, exists: true, name, bytes: bytes || 0, tables: tables || 0, dumps };
    },

    /**
     * Crée la base et son compte (rejouable). Sans fichier de compte (base neuve, ou CT reconstruit après une
     * perte) : nouveau mot de passe ; le .env reçoit les DB_* du compte actuel.
     */
    async createDb(slug) {
      const spec = await known(slug);
      let password = await dbPassword(spec.slug);
      if (!password) {
        password = randomBytes(24).toString("hex");
        await sys.writeFile(dbCnf(spec.slug), `[client]\nuser=${dbNameOf(spec.slug)}\npassword=${password}\nsocket=${MARIADB_SOCKET}\n`, 0o600);
      }
      await createDatabase(spec.slug, password);
      await writeEnv(spec.slug);
      return ops.dbState(spec.slug);
    },

    /** Importe un fichier SQL reçu (incoming/), puis le retire. */
    async importDb(slug, file, gz) {
      const spec = await known(slug);
      if (!(await dbPassword(spec.slug))) throw new OpError(409, "Pas de base pour ce site : la créer d'abord.");
      try {
        await importFrom(spec.slug, file, gz);
      } finally {
        await sys.rm(file);
      }
      return ops.dbState(spec.slug);
    },

    /** Export compressé dans incoming/ ; le serveur l'envoie puis le retire. */
    async exportDb(slug) {
      const spec = await known(slug);
      if (!(await dbPassword(spec.slug))) throw new OpError(409, "Pas de base pour ce site.");
      const file = path.posix.join(siteDir(spec.slug), "incoming", `export-${randomBytes(8).toString("hex")}.sql.gz`);
      await dumpTo(spec.slug, file);
      return { file };
    },

    /** Vide la base (supprimée puis recréée, droits du compte reposés). */
    async resetDb(slug) {
      const spec = await known(slug);
      const password = await dbPassword(spec.slug);
      if (!password) throw new OpError(409, "Pas de base pour ce site.");
      await rootSql(`DROP DATABASE IF EXISTS \`${dbNameOf(spec.slug)}\`;`, "Réinitialisation de la base");
      await createDatabase(spec.slug, password);
      return ops.dbState(spec.slug);
    },

    /** Dump avant publication (dumps/<version>.sql.gz, DUMPS_KEPT gardés) ; rien sans base. */
    async dumpBefore(slug, n) {
      const spec = await known(slug);
      versionOf(n);
      if (!(await dbPassword(spec.slug))) return { slug: spec.slug, dumped: false };
      await sys.mkdir(dumpsDir(spec.slug), 0o700);
      await dumpTo(spec.slug, path.posix.join(dumpsDir(spec.slug), `${n}.sql.gz`));
      const all = (await sys.readdir(dumpsDir(spec.slug))).map((f) => /^(\d+)\.sql\.gz$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => b - a);
      for (const old of all.slice(DUMPS_KEPT)) await sys.rm(path.posix.join(dumpsDir(spec.slug), `${old}.sql.gz`));
      return { slug: spec.slug, dumped: true, version: n };
    },

    /** Remet la base dans l'état du dump pris avant la publication de la version n. */
    async restoreDump(slug, n) {
      const spec = await known(slug);
      versionOf(n);
      const file = path.posix.join(dumpsDir(spec.slug), `${n}.sql.gz`);
      if (!(await sys.exists(file))) throw new OpError(404, `Pas de dump gardé pour la version ${n}.`);
      await ops.resetDb(spec.slug);
      await importFrom(spec.slug, file, true);
      return ops.dbState(spec.slug);
    },

    /**
     * Lance un script PHP du projet (migrations, création d'un compte...) sous le compte du site, comme ses pages :
     * open_basedir du site, 120 s au plus, sortie limitée et sans les valeurs du .env.
     */
    async runScript(slug, rel, args = [], stdin = "") {
      const spec = await known(slug);
      const script = checkScriptPath(rel);
      if (!Array.isArray(args) || args.length > 20 || !args.every((a) => typeof a === "string" && a.length <= 200 && !a.includes("\0"))) throw bad("Arguments : 20 au plus, 200 caractères chacun.");
      if (typeof stdin !== "string" || stdin.length > 4096) throw bad("Entrée standard : 4096 caractères au plus.");
      const home = siteDir(spec.slug);
      const current = path.posix.join(home, "current");
      if (!(await sys.exists(current))) throw new OpError(409, "Aucune version publiée : publier le site d'abord.");
      if (!(await sys.exists(path.posix.join(current, script)))) throw new OpError(404, `Script absent de la version servie : ${script}.`);
      const ids = idsOf(await sys.readFile(paths.passwdFile), userOf(spec.slug));
      const started = Date.now();
      const r = await sys.runIo(
        `/usr/bin/php${spec.php.replace(".", "")}`,
        [
          "-d",
          `open_basedir=${home}/`,
          "-d",
          `memory_limit=${spec.memoryLimitMb ?? 256}M`,
          "-d",
          "max_execution_time=120",
          "-d",
          `sys_temp_dir=${home}/tmp`,
          "-d",
          `upload_tmp_dir=${home}/tmp`,
          "-d",
          `error_log=${home}/logs/php-errors.log`,
          "-d",
          `pdo_mysql.default_socket=${MARIADB_SOCKET}`,
          "-d",
          `mysqli.default_socket=${MARIADB_SOCKET}`,
          "-d",
          `sendmail_path=/usr/local/lib/kouziaphp/mail-capture ${spec.slug}`,
          script,
          ...args,
        ],
        { input: stdin, uid: ids.uid, gid: ids.gid, cwd: current, env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: `${home}/tmp` }, timeoutMs: 120_000, maxOutput: 64 * 1024 },
      );
      // Valeurs du .env (variables saisies, mot de passe de la base) masquées dans la sortie affichée par le hub.
      const vars = (await sys.exists(envJson(spec.slug))) ? Object.values(JSON.parse(await sys.readFile(envJson(spec.slug)))) : [];
      const secrets = [...vars, (await dbPassword(spec.slug)) ?? "", ...stdin.split("\n")].filter((v) => v.length >= 6);
      const scrub = (text) => secrets.reduce((t, v) => t.split(v).join("••••"), text);
      return { slug: spec.slug, script, code: r.code, timedOut: r.timedOut === true, durationMs: Date.now() - started, output: scrub(`${r.stdout}${r.stderr}`).slice(-64 * 1024) };
    },

    /** Supprime le site : service, configurations, compte et dossier. La base (lot P4) est retirée à part. */
    async remove(slug) {
      const spec = await known(slug);
      const svc = serviceOf(spec.slug);
      await sys.run("/sbin/rc-service", [svc, "stop"]);
      await sys.run("/sbin/rc-update", ["del", svc, "default"]);
      for (const p of [
        path.posix.join(paths.initDir, svc),
        path.posix.join(paths.confdDir, svc),
        path.posix.join(paths.confDir, "fpm", `${spec.slug}.conf`),
        path.posix.join(paths.nginxSitesDir, `${spec.slug}.conf`),
        path.posix.join(paths.nginxSitesDir, `${spec.slug}.conf.off`),
      ]) {
        await sys.rm(p);
      }
      await reloadNginx();
      if (await sys.exists(dbCnf(spec.slug))) {
        const name = dbNameOf(spec.slug);
        await rootSql(`DROP DATABASE IF EXISTS \`${name}\`;\nDROP USER IF EXISTS '${name}'@'localhost';`, "Suppression de la base");
      }
      await sys.rm(dbCnf(spec.slug));
      await sys.rm(envJson(spec.slug));
      await writeCron({ ...spec, cron: null }, false);
      await sys.run("/usr/sbin/deluser", [userOf(spec.slug)]);
      // Chemin construit depuis un slug validé, sous le dossier des sites : jamais autre chose.
      const home = siteDir(spec.slug);
      if (path.posix.dirname(home) !== paths.sitesDir || !SLUG_RE.test(path.posix.basename(home))) throw new OpError(500, "Chemin du site inattendu : rien supprimé.");
      await sys.rm(home);
      await sys.rm(path.posix.join(paths.confDir, "sites", `${spec.slug}.json`));
      await writeNetwork();
      return { slug: spec.slug, removed: true };
    },
  };
  return ops;
}

/** Empreinte SHA-256 d'un fichier (archive reçue). */
export function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => hash.update(c))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

/** Actions système réelles (Node, sans shell). */
export function realSys(runImpl) {
  return {
    run: runImpl,
    readFile: (p) => fsp.readFile(p, "utf8"),
    async writeFile(p, text, mode) {
      await fsp.mkdir(path.posix.dirname(p), { recursive: true });
      const tmp = `${p}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, text, { mode });
      await fsp.chmod(tmp, mode);
      await fsp.rename(tmp, p);
    },
    async mkdir(p, mode) {
      await fsp.mkdir(p, { recursive: true, mode });
      await fsp.chmod(p, mode);
    },
    rm: (p) => fsp.rm(p, { recursive: true, force: true }),
    symlink: (target, p) => fsp.symlink(target, p),
    rename: (a, b) => fsp.rename(a, b),
    readdir: (p) => fsp.readdir(p),
    async chown(p, user, group) {
      const r = await runImpl("/bin/chown", [`${user}:${group}`, p]);
      if (r.code !== 0) throw new OpError(500, `Droits de ${p} : échec.`);
    },
    exists: (p) => fsp.lstat(p).then(() => true, () => false),
    cp: (a, b) => fsp.cp(a, b, { recursive: true, dereference: false, verbatimSymlinks: true }),
    runIo,
  };
}

/**
 * Commande sans shell, avec entrée et sortie en flux : entrée depuis un texte (input) ou un fichier (inputFile,
 * décompressé si gunzip), sortie vers un fichier (outputFile, compressée si gzip, 600) ou gardée (maxOutput
 * octets au plus). uid/gid : sous un autre compte (libuv retire alors les groupes supplémentaires de root).
 */
export function runIo(file, args, io = {}) {
  return new Promise((resolve) => {
    // Sans entrée : stdin vide (/dev/null), rien à écrire. Écrire dans le stdin d'une commande déjà finie (mkdir,
    // chmod sortent aussitôt) donnait un EPIPE non rattrapé qui arrêtait tout l'agent (publication de my-takumi).
    const withInput = io.input !== undefined || io.inputFile !== undefined;
    const child = spawn(file, args, {
      stdio: [withInput ? "pipe" : "ignore", "pipe", "pipe"],
      ...(io.uid !== undefined ? { uid: io.uid, gid: io.gid } : {}),
      ...(io.cwd ? { cwd: io.cwd } : {}),
      ...(io.env ? { env: io.env } : {}),
    });
    const max = io.maxOutput ?? 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const keep = (acc, chunk) => (acc.length < max ? acc + chunk.toString("utf8").slice(0, max - acc.length) : acc);
    // Erreur d'un flux (commande sortie sans tout lire, lancement refusé) : notée dans stderr, jamais levée.
    const streamError = (err) => (stderr = keep(stderr, Buffer.from(` ${err.message}`)));
    child.stdin?.on("error", streamError);
    child.stdout.on("error", streamError);
    child.stderr.on("error", streamError);
    child.stderr.on("data", (c) => (stderr = keep(stderr, c)));
    const writing = io.outputFile
      ? pipeline(child.stdout, ...(io.gzip ? [createGzip()] : []), createWriteStream(io.outputFile, { mode: 0o600 })).catch((err) => {
          stderr = keep(stderr, Buffer.from(` ${err.message}`));
        })
      : (child.stdout.on("data", (c) => (stdout = keep(stdout, c))), Promise.resolve());
    const reading = io.inputFile
      ? pipeline(createReadStream(io.inputFile), ...(io.gunzip ? [createGunzip()] : []), child.stdin).catch((err) => {
          stderr = keep(stderr, Buffer.from(` ${err.message}`));
          child.kill();
        })
      : (withInput && child.stdin.end(io.input), Promise.resolve());
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, io.timeoutMs ?? 60_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      await Promise.all([writing, reading]);
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr: timedOut ? `${stderr} délai dépassé` : stderr, timedOut });
    });
  });
}
