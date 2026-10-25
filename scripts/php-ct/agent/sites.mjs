// Opérations de l'agent sur les sites PHP (docs/cadrage.md, sections 11.2 à 11.5, lot P3). L'agent tourne en root :
// chaque paramètre est validé ici, chaque chemin est construit depuis un identifiant contrôlé, aucune commande ne
// passe par un shell. Les actions système passent par « sys » (remplacé dans les tests).
//
// Disposition d'un site, /srv/sites/<slug>/ (root:php-<slug>, 750) :
//   releases/<n>/   versions publiées, à root, lecture seule pour le site (750/640, groupe du site)
//   current         lien vers la version servie (bascule atomique, retour arrière)
//   shared/         dossiers persistants (data/...) et .env (lot P4), au compte du site, 700
//   tmp/ sessions/ logs/ mail/   au compte du site (mail/ : e-mails capturés, lot P5)
//   incoming/       archives reçues, à root, 700
// Compte php-<slug> (UID 20000 à 29999, groupe à lui ; nginx est ajouté à ce groupe pour lire les fichiers).
// PHP-FPM : un maître par site (service OpenRC kouziaphp-site.<slug>), socket /run/kouziaphp/<slug>.sock.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";

export const SITE_UID_MIN = 20000;
export const SITE_UID_MAX = 29999;
export const RELEASES_KEPT = 5;
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DIR_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const PHP_RE = /^8\.[2-5]$/;

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
  return {
    slug,
    hostname: input.hostname,
    php: input.php,
    publicDir,
    persistentDirs,
    indexing: input.indexing === true,
  };
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
  return `# Généré par l'agent des sites PHP pour ${spec.hostname}. Ne pas modifier : réécrit à chaque réglage.
server {
    listen 127.0.0.1:${paths.nginxPort};
    server_name ${spec.hostname};
    root ${root};
    index index.php index.html;
    client_max_body_size 34m;
    access_log ${paths.sitesDir}/${spec.slug}/logs/nginx-access.log;
    error_log ${paths.sitesDir}/${spec.slug}/logs/nginx-error.log warn;
${noindex}${robots}
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
request_terminate_timeout = 30s
slowlog = ${home}/logs/php-slow.log
request_slowlog_timeout = 5s
catch_workers_output = yes
clear_env = yes
php_admin_value[open_basedir] = ${home}/
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
  if (limits) lines.push('rc_cgroup_settings="', "memory.max 512M", "cpu.max 100000 100000", "pids.max 64", '"');
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

  async function writeConfigs(spec) {
    await sys.writeFile(path.posix.join(paths.confDir, "sites", `${spec.slug}.json`), `${JSON.stringify(spec, null, 2)}\n`, 0o600);
    await sys.writeFile(path.posix.join(paths.confDir, "fpm", `${spec.slug}.conf`), fpmConf(spec, paths), 0o644);
    await sys.writeFile(path.posix.join(paths.confdDir, serviceOf(spec.slug)), serviceConf(spec, ctx.limitsEffective()), 0o644);
    const conf = path.posix.join(paths.nginxSitesDir, `${spec.slug}.conf`);
    const off = `${conf}.off`;
    // Site coupé : sa configuration reste désactivée (.off) jusqu'au rallumage.
    const target = (await sys.exists(off)) ? off : conf;
    await sys.writeFile(target, nginxConf(spec, paths), 0o644);
  }

  async function reloadNginx() {
    await run("/usr/sbin/nginx", ["-t"], "Configuration nginx");
    await run("/sbin/rc-service", ["nginx", "reload"], "Rechargement de nginx");
  }

  return {
    /** Fichier où écrire l'archive reçue d'un site connu (incoming/, à root), nommé par le nonce de la requête. */
    async incomingFile(slug, nonce) {
      const spec = await known(slug);
      if (!/^[0-9a-f]{32}$/.test(nonce)) throw bad("Nonce invalide.");
      return path.posix.join(siteDir(spec.slug), "incoming", `${nonce}.tar.gz`);
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
        ["shared", user, user, 0o700],
        ["tmp", user, user, 0o700],
        ["sessions", user, user, 0o700],
        ["logs", user, user, 0o750],
        ["mail", user, user, 0o700],
      ]) {
        const p = path.posix.join(home, dir);
        await sys.mkdir(p, mode);
        await sys.chown(p, owner, group);
      }
      await writeConfigs(spec);
      const init = path.posix.join(paths.initDir, serviceOf(spec.slug));
      if (!(await sys.exists(init))) await sys.symlink(path.posix.join(paths.initDir, "kouziaphp-site"), init);
      await reloadNginx();
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
      for (const d of spec.persistentDirs) {
        const shared = path.posix.join(home, "shared", d);
        const inRelease = path.posix.join(dir, d);
        // Première publication : le contenu envoyé initialise le dossier persistant ; ensuite il n'est plus touché.
        if (!(await sys.exists(shared))) {
          await sys.mkdir(path.posix.dirname(shared), 0o700);
          if (await sys.exists(inRelease)) await sys.cp(inRelease, shared);
          else await sys.mkdir(shared, 0o700);
          await run("/bin/chown", ["-R", `${userOf(spec.slug)}:${userOf(spec.slug)}`, shared], "Droits du dossier persistant");
        }
        await sys.rm(inRelease);
        await sys.mkdir(path.posix.dirname(inRelease), 0o750);
        await sys.symlink(shared, inRelease);
      }
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
      return { slug: spec.slug, enabled };
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
      const leaks = results.filter((r) => r.status !== 403 && r.status !== 404);
      return { slug: spec.slug, ok: leaks.length === 0, results };
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
      await sys.run("/usr/sbin/deluser", [userOf(spec.slug)]);
      // Chemin construit depuis un slug validé, sous le dossier des sites : jamais autre chose.
      const home = siteDir(spec.slug);
      if (path.posix.dirname(home) !== paths.sitesDir || !SLUG_RE.test(path.posix.basename(home))) throw new OpError(500, "Chemin du site inattendu : rien supprimé.");
      await sys.rm(home);
      await sys.rm(path.posix.join(paths.confDir, "sites", `${spec.slug}.json`));
      return { slug: spec.slug, removed: true };
    },
  };
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
  };
}
