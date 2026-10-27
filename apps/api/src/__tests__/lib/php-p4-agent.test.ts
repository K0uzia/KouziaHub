import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DISABLED_FUNCTIONS,
  checkCron,
  checkEnvVars,
  cronLine,
  checkSiteSpec,
  dbNameOf,
  envFileText,
  fpmConf,
  nginxConf,
  serviceConf,
  siteOperations,
  type Paths,
} from "../../../../../scripts/php-ct/agent/sites.mjs";
import { memorySys } from "../helpers/php-memory.js";

// Lot P4 de l'agent (docs/cadrage.md, 11.3 et 11.5) : base, .env, dumps, script du projet, dossiers persistants
// publics, limites en php_admin_value. Système simulé en mémoire : commandes et entrées vérifiées sans root.

const paths: Paths = {
  sitesDir: "/srv/sites",
  confDir: "/etc/kouziaphp",
  nginxSitesDir: "/etc/nginx/kouziaphp-sites",
  nginxPort: 8080,
  runDir: "/run/kouziaphp",
  initDir: "/etc/init.d",
  confdDir: "/etc/conf.d",
  passwdFile: "/etc/passwd",
};
const ctx = { domain: "kouzia.com", phpInstalled: () => ["8.3"] };
// MyTakumi : data/ privé, images envoyées par son back-office dans public/assets/img/oeuvres/.
const spec = {
  slug: "mytakumi",
  hostname: "mytakumi.kouzia.com",
  php: "8.3",
  publicDir: "public",
  persistentDirs: ["data"],
  publicPersistentDirs: ["public/assets/img/oeuvres"],
  memoryLimitMb: 1024,
  uploadMaxMb: 100,
  maxExecutionSec: 120,
};
const PASSWD = "root:x:0:0::/root:/bin/sh\nphp-autre:x:20000:20000::/srv/sites/autre:/sbin/nologin\nphp-mytakumi:x:20001:20005::/srv/sites/mytakumi:/sbin/nologin\n";

function cluster(answer?: (file: string, args: string[]) => { code: number; stdout: string; stderr: string }) {
  const m = memorySys(answer ?? ((file, args) => (file === "/sbin/rc-service" && args[1] === "status" ? { code: 3, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" })));
  let served: (p: string) => boolean = () => false;
  const ops = siteOperations({ ...ctx, paths, limitsEffective: () => true, httpStatus: async (_h: string, p: string) => (served(p) ? 200 : 403), sys: m.sys });
  return { m, ops, serve: (rule: (p: string) => boolean) => (served = rule) };
}
const text = (m: ReturnType<typeof memorySys>, p: string) => (m.nodes.get(p) as { text?: string } | undefined)?.text ?? null;

describe("réglages P4 : dossiers persistants publics, mémoire, taille d'envoi", () => {
  it("cas MyTakumi accepté ; dossiers et limites douteux refusés", () => {
    expect(checkSiteSpec(spec, ctx)).toMatchObject({ publicPersistentDirs: ["public/assets/img/oeuvres"], memoryLimitMb: 1024, uploadMaxMb: 100, maxExecutionSec: 120 });
    expect(checkSiteSpec({ ...spec, memoryLimitMb: undefined, uploadMaxMb: undefined, maxExecutionSec: undefined }, ctx)).toMatchObject({ memoryLimitMb: 256, uploadMaxMb: 32, maxExecutionSec: 30 });
    for (const [over, msg] of [
      [{ publicPersistentDirs: ["assets/img"] }, /hors du dossier public/],
      [{ publicPersistentDirs: ["public/../data"] }, /Dossier invalide/],
      [{ publicPersistentDirs: ["public/a", "public/a/b"] }, /imbriqués/],
      [{ memoryLimitMb: 1025 }, /64 à 1024/],
      [{ memoryLimitMb: 256.5 }, /64 à 1024/],
      [{ uploadMaxMb: 129 }, /1 à 128/],
      [{ maxExecutionSec: 121 }, /5 à 120/],
      [{ maxExecutionSec: 4 }, /5 à 120/],
    ] as const) {
      expect(() => checkSiteSpec({ ...spec, ...over }, ctx), JSON.stringify(over)).toThrow(msg);
    }
  });

  it("nginx : dossier public persistant servi en statique, jamais exécuté ; corps et délai à la mesure du site", () => {
    const conf = nginxConf(checkSiteSpec(spec, ctx), paths);
    // Corps : deux fois l'envoi, 256 Mo au plus ; délai de PHP : durée maximale plus 10 s.
    expect(conf).toContain("client_max_body_size 200m;");
    expect(nginxConf(checkSiteSpec({ ...spec, uploadMaxMb: 128 }, ctx), paths)).toContain("client_max_body_size 256m;");
    expect(conf).toContain("fastcgi_read_timeout 130s;");
    // Comme nginx : un préfixe « ^~ » qui correspond l'emporte sur toute location regex de premier niveau
    // (dont la règle PHP) ; seules ses locations imbriquées s'appliquent.
    const block = /location \^~ (\S+) \{([\s\S]*?)\n {4}\}/.exec(conf);
    expect(block?.[1]).toBe("/assets/img/oeuvres/");
    const nested = [...block![2]!.matchAll(/location (~\*?) (\S+) \{ (.*) \}/g)].map((x) => ({ re: new RegExp(x[2]!, x[1] === "~*" ? "i" : ""), action: x[3] }));
    for (const p of ["/assets/img/oeuvres/x.php", "/assets/img/oeuvres/a/b.PHP", "/assets/img/oeuvres/x.phtml", "/assets/img/oeuvres/.htaccess"]) {
      expect(nested.find((r) => r.re.test(p))?.action, p).toBe("return 403;");
    }
    expect(nested.find((r) => r.re.test("/assets/img/oeuvres/vase-960.webp"))).toBeUndefined();
    // Servi directement depuis shared/, sans suivre aucun lien : nginx est dans le groupe de chaque site, un lien posé
    // par un site vers le .env d'un autre ne doit jamais être servi (audit du 27/10/2026).
    expect(block![2]).toContain("alias /srv/sites/mytakumi/shared/public/assets/img/oeuvres/;");
    expect(block![2]).toContain("disable_symlinks on from=/srv/sites/mytakumi/shared/public/assets/img/oeuvres;");
    expect(block![2]).not.toContain("/current/");
  });

  it("PHP-FPM : limites en php_admin_value (le .user.ini du projet n'y peut rien), socket MariaDB par défaut", () => {
    const fpm = fpmConf(checkSiteSpec(spec, ctx), paths);
    expect(fpm).toContain("php_admin_value[memory_limit] = 1024M");
    expect(fpm).toContain("php_admin_value[max_execution_time] = 120");
    expect(fpm).toContain("request_terminate_timeout = 125s");
    expect(fpm).toContain("php_admin_value[upload_max_filesize] = 100M");
    expect(fpm).toContain("php_admin_value[post_max_size] = 200M");
    expect(fpm).toContain("php_admin_value[pdo_mysql.default_socket] = /run/mysqld/mysqld.sock");
    expect(fpm).not.toMatch(/^php_value\[(memory_limit|upload_max_filesize|post_max_size)\]/m);
    // Groupe de contrôle du site : une requête à pleine mémoire et 256 Mo pour le reste.
    expect(serviceConf(checkSiteSpec(spec, ctx), true)).toContain("memory.max 1280M\nmemory.swap.max 0\n");
    expect(serviceConf(checkSiteSpec({ ...spec, memoryLimitMb: undefined }, ctx), true)).toContain("memory.max 512M\n");
  });
});

describe("variables d'environnement", () => {
  it("noms et valeurs validés ; DB_* réservées ; clés live refusées, clés de test acceptées", () => {
    expect(checkEnvVars({ APP_URL: "https://mytakumi.kouzia.com", APP_ENV: "production", STRIPE: "sk_test_abc123" })).toEqual({
      APP_ENV: "production",
      APP_URL: "https://mytakumi.kouzia.com",
      STRIPE: "sk_test_abc123",
    });
    for (const [vars, msg] of [
      [{ app_env: "x" }, /Nom de variable invalide/],
      [{ DB_PASSWORD: "x" }, /rempli d'office/],
      [{ DB_DSN: "sqlite:x" }, /rempli d'office/],
      [{ STRIPE: "sk_live_abc" }, /clé de paiement réelle/],
      [{ STRIPE_PK: "pk_live_abc" }, /clé de paiement réelle/],
      [{ A: 'a"b' }, /guillemet/],
      [{ A: "a$b" }, /guillemet/],
      [{ A: "a\nB=1" }, /retour à la ligne/],
      [{ A: 3 }, /refusée/],
      [[], /Variables attendues/],
    ] as const) {
      expect(() => checkEnvVars(vars), JSON.stringify(vars)).toThrow(msg);
    }
  });

  it("nom de base : s_ et le slug (tirets en _), 64 caractères au plus", () => {
    expect(dbNameOf("my-takumi")).toBe("s_my_takumi");
    const long = dbNameOf("a".repeat(63));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).not.toBe(dbNameOf(`${"a".repeat(62)}b`));
  });

  it(".env : valeurs entre guillemets, DSN de MyTakumi par le socket", () => {
    const t = envFileText({ APP_ENV: "production" }, { DB_DSN: "mysql:unix_socket=/run/mysqld/mysqld.sock;dbname=s_mytakumi;charset=utf8mb4" });
    expect(t).toContain('APP_ENV="production"\n');
    expect(t).toContain('DB_DSN="mysql:unix_socket=/run/mysqld/mysqld.sock;dbname=s_mytakumi;charset=utf8mb4"\n');
  });
});

describe("base, .env et dumps sur le CT (système simulé)", () => {
  async function site() {
    const c = cluster();
    c.m.nodes.set("/etc/passwd", { type: "file", text: PASSWD });
    await c.ops.upsert(spec);
    return c;
  }

  it("création : compte et base par l'entrée standard, mot de passe jamais en argument ; .env rempli et protégé", async () => {
    const { m, ops } = await site();
    // .env posé dès la création : root:php-<slug>, lisible du site seul, hors du dossier public.
    expect(text(m, "/srv/sites/mytakumi/.env")).toMatch(/^# Écrit par l'agent/);
    expect(m.owners.get("/srv/sites/mytakumi/.env")).toBe("root:php-mytakumi");
    expect(m.owners.get("/srv/sites/mytakumi/dumps")).toBe("root:root");

    m.runs.length = 0;
    await ops.createDb("mytakumi");
    const cnf = text(m, "/etc/kouziaphp/sites/mytakumi.db.cnf")!;
    const password = /^password=([0-9a-f]{48})$/m.exec(cnf)?.[1];
    expect(password).toBeDefined();
    expect(m.runs.join("\n")).not.toContain(password);
    const sql = m.inputs.find((i) => i.file === "/usr/bin/mariadb")!.input!;
    expect(sql).toContain("CREATE DATABASE IF NOT EXISTS `s_mytakumi` CHARACTER SET utf8mb4");
    expect(sql).toContain(`CREATE USER IF NOT EXISTS 's_mytakumi'@'localhost' IDENTIFIED BY '${password}' WITH MAX_USER_CONNECTIONS 10;`);
    expect(sql).toContain("GRANT ALL PRIVILEGES ON `s_mytakumi`.* TO 's_mytakumi'@'localhost';");
    const env = text(m, "/srv/sites/mytakumi/.env")!;
    expect(env).toContain('DB_DSN="mysql:unix_socket=/run/mysqld/mysqld.sock;dbname=s_mytakumi;charset=utf8mb4"');
    expect(env).toContain(`DB_PASSWORD="${password}"`);

    // Rejouable : même mot de passe.
    await ops.createDb("mytakumi");
    expect(text(m, "/etc/kouziaphp/sites/mytakumi.db.cnf")).toBe(cnf);
  });

  it("variables : gardées à root, .env réécrit avec celles de la base ; clé live refusée sans rien changer", async () => {
    const { m, ops } = await site();
    await ops.createDb("mytakumi");
    await ops.setEnv("mytakumi", { APP_ENV: "production", APP_URL: "https://mytakumi.kouzia.com" });
    const env = text(m, "/srv/sites/mytakumi/.env")!;
    expect(env.indexOf('APP_ENV="production"')).toBeLessThan(env.indexOf("DB_DSN"));
    expect(text(m, "/etc/kouziaphp/sites/mytakumi.env.json")).toBe('{"APP_ENV":"production","APP_URL":"https://mytakumi.kouzia.com"}\n');
    await expect(ops.setEnv("mytakumi", { STRIPE_SECRET: "sk_live_x1" })).rejects.toThrow(/live/);
    expect(text(m, "/srv/sites/mytakumi/.env")).toBe(env);
  });

  it("publication : .env relié à la racine de la version ; dossier public persistant initialisé, lisible de nginx", async () => {
    const { m, ops } = await site();
    m.nodes.set("/srv/sites/mytakumi/releases/1", { type: "dir" });
    m.nodes.set("/srv/sites/mytakumi/releases/1/public/assets/img/oeuvres", { type: "dir" });
    m.nodes.set("/srv/sites/mytakumi/releases/1/public/assets/img/oeuvres/vase.webp", { type: "file", text: "image livrée" });
    await ops.publish("mytakumi", 1);
    expect(m.nodes.get("/srv/sites/mytakumi/releases/1/.env")).toEqual({ type: "link", target: "/srv/sites/mytakumi/.env" });
    expect(text(m, "/srv/sites/mytakumi/shared/public/assets/img/oeuvres/vase.webp")).toBe("image livrée");
    expect(m.nodes.get("/srv/sites/mytakumi/releases/1/public/assets/img/oeuvres")).toEqual({ type: "link", target: "/srv/sites/mytakumi/shared/public/assets/img/oeuvres" });
    expect(m.runs).toContain("/bin/chmod -R u=rwX,g=rX,o= /srv/sites/mytakumi/shared/public/assets/img/oeuvres");
    expect(m.runs).toContain("/bin/chmod -R u=rwX,go= /srv/sites/mytakumi/shared/data");

    // Version 2 : les images envoyées par le site (dans shared/) restent, celles de l'envoi ne les écrasent pas.
    m.nodes.set("/srv/sites/mytakumi/shared/public/assets/img/oeuvres/envoyee.webp", { type: "file", text: "envoyée par le back-office" });
    m.nodes.set("/srv/sites/mytakumi/releases/2", { type: "dir" });
    await ops.publish("mytakumi", 2);
    expect(text(m, "/srv/sites/mytakumi/shared/public/assets/img/oeuvres/envoyee.webp")).toBe("envoyée par le back-office");
  });

  it("page d'attente d'abord, puis le projet : les images envoyées remplissent le dossier persistant ; un fichier modifié par le site est gardé", async () => {
    const { m, ops } = await site();
    const shared = "/srv/sites/mytakumi/shared/public/assets/img/oeuvres";
    // Version 1 : page d'attente seule (création du site), sans images ni data/.
    m.nodes.set("/srv/sites/mytakumi/releases/1", { type: "dir" });
    m.nodes.set("/srv/sites/mytakumi/releases/1/public/index.html", { type: "file", text: "attente" });
    await ops.publish("mytakumi", 1);
    expect([...m.nodes.keys()].filter((k) => k.startsWith(`${shared}/`))).toEqual([]);

    // Version 2 : le projet, avec ses images et data/app.key.
    m.nodes.set("/srv/sites/mytakumi/releases/2", { type: "dir" });
    m.nodes.set("/srv/sites/mytakumi/releases/2/public/assets/img/oeuvres", { type: "dir" });
    m.nodes.set("/srv/sites/mytakumi/releases/2/public/assets/img/oeuvres/vase-960.webp", { type: "file", text: "vase livré" });
    m.nodes.set("/srv/sites/mytakumi/releases/2/public/assets/img/oeuvres/bol-960.webp", { type: "file", text: "bol livré" });
    m.nodes.set("/srv/sites/mytakumi/releases/2/data", { type: "dir" });
    m.nodes.set("/srv/sites/mytakumi/releases/2/data/app.key", { type: "file", text: "clé du zip" });
    m.inputs.length = 0;
    await ops.publish("mytakumi", 2);
    expect(text(m, `${shared}/vase-960.webp`)).toBe("vase livré");
    expect(text(m, `${shared}/bol-960.webp`)).toBe("bol livré");
    expect(text(m, "/srv/sites/mytakumi/shared/data/app.key")).toBe("clé du zip");
    // Création, copie et droits sous le compte du site (UID 20001, groupe 20005), jamais en root.
    for (const call of m.inputs.filter((i) => i.file === "/bin/mkdir" || i.file === "/bin/chmod" || i.args[0] === "-e")) {
      expect(call.io, `${call.file} ${call.args.join(" ")}`).toMatchObject({ uid: 20001, gid: 20005 });
    }
    expect(m.runs.some((r) => r.startsWith("/bin/chown -R") && r.includes("/shared"))).toBe(false);

    // Le site remplace une image et la clé ; republier la version 2 (ou en publier une 3) ne les touche pas.
    m.nodes.set(`${shared}/vase-960.webp`, { type: "file", text: "vase retouché par le site" });
    m.nodes.set("/srv/sites/mytakumi/shared/data/app.key", { type: "file", text: "clé de production" });
    m.nodes.set("/srv/sites/mytakumi/releases/3", { type: "dir" });
    m.nodes.set("/srv/sites/mytakumi/releases/3/public/assets/img/oeuvres", { type: "dir" });
    m.nodes.set("/srv/sites/mytakumi/releases/3/public/assets/img/oeuvres/vase-960.webp", { type: "file", text: "vase livré" });
    m.nodes.set("/srv/sites/mytakumi/releases/3/public/assets/img/oeuvres/tasse-960.webp", { type: "file", text: "tasse livrée" });
    await ops.publish("mytakumi", 3);
    expect(text(m, `${shared}/vase-960.webp`)).toBe("vase retouché par le site");
    expect(text(m, `${shared}/tasse-960.webp`)).toBe("tasse livrée");
    expect(text(m, "/srv/sites/mytakumi/shared/data/app.key")).toBe("clé de production");
  });

  it("site publié par l'ancien agent (parents de shared/ créés en root) : repris, puis publié ; un lien posé par le site est refusé", async () => {
    const { m, ops } = await site();
    // État laissé par l'ancien agent : shared/ au site, mais shared/public/ et shared/public/assets/ en root.
    for (const d of ["shared/public", "shared/public/assets"]) m.nodes.set(`/srv/sites/mytakumi/${d}`, { type: "dir" });
    m.owners.delete("/srv/sites/mytakumi/shared/public");
    m.nodes.set("/srv/sites/mytakumi/releases/1", { type: "dir" });
    m.nodes.set("/srv/sites/mytakumi/releases/1/public/assets/img/oeuvres", { type: "dir" });
    m.nodes.set("/srv/sites/mytakumi/releases/1/public/assets/img/oeuvres/vase.webp", { type: "file", text: "vase" });
    m.runs.length = 0;
    await ops.publish("mytakumi", 1);
    // Rendus au compte du site AVANT la création sous son compte, par descripteurs ouverts sans suivre de lien à aucun
    // niveau : un parent remplacé par un lien entre deux étapes ne mène root nulle part (revue de l'agent, TOCTOU).
    const claimPublic = m.runs.indexOf("claim /srv/sites/mytakumi/shared/public 20001:20005 750");
    const claimAssets = m.runs.indexOf("claim /srv/sites/mytakumi/shared/public/assets 20001:20005 750");
    const mkdirAsSite = m.runs.indexOf("/bin/mkdir -p /srv/sites/mytakumi/shared/public/assets/img/oeuvres");
    expect(claimPublic).toBeGreaterThanOrEqual(0);
    expect(claimAssets).toBeGreaterThan(claimPublic);
    expect(mkdirAsSite).toBeGreaterThan(claimAssets);
    // Plus aucun stat, chown ou chmod de root sur un chemin du site (ils suivaient les parents).
    const rootOnShared = m.runs.filter((r) => /^\/bin\/(stat|chown) /.test(r) && r.includes("/shared/"));
    expect(rootOnShared).toEqual([]);
    expect(text(m, "/srv/sites/mytakumi/shared/public/assets/img/oeuvres/vase.webp")).toBe("vase");
    // Republication : déjà au compte du site, rien à reprendre.
    m.runs.length = 0;
    await ops.publish("mytakumi", 1);
    expect(m.runs.some((r) => r.startsWith("claim "))).toBe(false);

    // Le site a remplacé un parent par un lien vers ailleurs : refus, root ne touche à rien au-delà.
    m.nodes.set("/srv/sites/mytakumi/shared/public/assets", { type: "link", target: "/etc" });
    m.runs.length = 0;
    await expect(ops.publish("mytakumi", 1)).rejects.toThrow(/est un lien, refusé/);
    // (data/, traité avant, n'est pas en cause.)
    expect(m.runs.some((r) => (r.startsWith("claim") || r.startsWith("/bin/mkdir")) && r.includes("/shared/public"))).toBe(false);
  });

  it("contrôle anti-fuite : un .php déposé dans un dossier public persistant ne doit pas s'exécuter (sonde retirée)", async () => {
    const { m, ops, serve } = await site();
    m.nodes.set("/srv/sites/mytakumi/releases/1", { type: "dir" });
    await ops.publish("mytakumi", 1);
    const ok = await ops.check("mytakumi");
    const probe = ok.results.find((r) => r.path.startsWith("/assets/img/oeuvres/kouzia-sonde-"));
    expect(probe?.status).toBe(403);
    expect(ok.ok).toBe(true);
    expect([...m.nodes.keys()].some((k) => k.includes("kouzia-sonde"))).toBe(false);
    // nginx mal réglé qui exécuterait le .php déposé (200) : fuite signalée, sonde retirée quand même.
    serve((p) => p.includes("/kouzia-sonde-"));
    const bad = await ops.check("mytakumi");
    expect(bad.ok).toBe(false);
    expect(bad.results.find((r) => r.path.includes("/kouzia-sonde-"))?.status).toBe(200);
    expect([...m.nodes.keys()].some((k) => k.includes("kouzia-sonde"))).toBe(false);
    // Sonde posée et retirée SOUS LE COMPTE DU SITE (dossier qu'il contrôle : un lien posé à l'avance ne mène root nulle part).
    const probeCalls = m.inputs.filter((i) => i.args.some((x) => x.includes("kouzia-sonde-")));
    expect(probeCalls.length).toBeGreaterThanOrEqual(4);
    for (const call of probeCalls) expect(call.io, `${call.file} ${call.args.join(" ")}`).toMatchObject({ uid: 20001, gid: 20005 });
  });

  it("dumps avant publication : rien sans base ; 5 gardés ; restauration = base vidée puis dump importé", async () => {
    const { m, ops } = await site();
    expect(await ops.dumpBefore("mytakumi", 1)).toEqual({ slug: "mytakumi", dumped: false });
    await ops.createDb("mytakumi");
    for (const n of [1, 2, 3, 4, 5, 6, 7]) await ops.dumpBefore("mytakumi", n);
    expect((await ops.dbState("mytakumi")).dumps).toEqual([7, 6, 5, 4, 3]);
    const dump = m.inputs.find((i) => i.file === "/usr/bin/mariadb-dump")!;
    expect(dump.args).toEqual(["--defaults-extra-file=/etc/kouziaphp/sites/mytakumi.db.cnf", "--single-transaction", "--no-tablespaces", "--routines", "--triggers", "s_mytakumi"]);
    expect(dump.io).toMatchObject({ outputFile: "/srv/sites/mytakumi/dumps/1.sql.gz", gzip: true });

    m.inputs.length = 0;
    await ops.restoreDump("mytakumi", 6);
    expect(m.inputs[0]!.input).toBe("DROP DATABASE IF EXISTS `s_mytakumi`;");
    expect(m.inputs[1]!.input).toContain("CREATE DATABASE IF NOT EXISTS `s_mytakumi`");
    const imported = m.inputs.findIndex((i) => i.io.inputFile);
    expect(imported).toBeGreaterThan(1);
    expect(m.inputs[imported]).toMatchObject({ args: ["--defaults-extra-file=/etc/kouziaphp/sites/mytakumi.db.cnf", "--sandbox", "s_mytakumi"], io: { inputFile: "/srv/sites/mytakumi/dumps/6.sql.gz", gunzip: true } });
    await expect(ops.restoreDump("mytakumi", 1)).rejects.toThrow(/Pas de dump/);
  });

  it("reprise d'une publication déjà basculée : le dump d'avant la version est gardé, jamais refait (audit P1-b)", async () => {
    const { m, ops } = await site();
    await ops.createDb("mytakumi");
    await ops.dumpBefore("mytakumi", 3);
    const dumps = () => m.inputs.filter((i) => i.file === "/usr/bin/mariadb-dump").length;
    expect(dumps()).toBe(1);
    // Première tentative : bascule faite, réponse perdue. La reprise redemande le dump : la base a déjà pu migrer.
    m.nodes.set("/srv/sites/mytakumi/current", { type: "link", target: "releases/3" });
    expect(await ops.dumpBefore("mytakumi", 3)).toEqual({ slug: "mytakumi", dumped: false, kept: true, version: 3 });
    expect(dumps()).toBe(1);
    // Version pas encore servie (échec avant la bascule) : la base est toujours celle d'avant, dump refait.
    m.nodes.set("/srv/sites/mytakumi/current", { type: "link", target: "releases/2" });
    await ops.dumpBefore("mytakumi", 3);
    expect(dumps()).toBe(2);
  });

  it("import avec le compte du site (fichier retiré ensuite), export compressé ; sans base : refus clair", async () => {
    const { m, ops } = await site();
    m.nodes.set("/srv/sites/mytakumi/incoming/a.sql", { type: "file", text: "CREATE TABLE t (id INT);" });
    await expect(ops.importDb("mytakumi", "/srv/sites/mytakumi/incoming/a.sql", false)).rejects.toThrow(/créer d'abord/);
    await ops.createDb("mytakumi");
    m.inputs.length = 0;
    await ops.importDb("mytakumi", "/srv/sites/mytakumi/incoming/a.sql", false);
    expect(m.inputs[0]).toMatchObject({ file: "/usr/bin/mariadb", args: ["--defaults-extra-file=/etc/kouziaphp/sites/mytakumi.db.cnf", "--sandbox", "s_mytakumi"], input: "CREATE TABLE t (id INT);" });
    expect(m.nodes.has("/srv/sites/mytakumi/incoming/a.sql")).toBe(false);
    const { file } = await ops.exportDb("mytakumi");
    expect(file).toMatch(/^\/srv\/sites\/mytakumi\/incoming\/export-[0-9a-f]{16}\.sql\.gz$/);
  });

  it("import refusé par MariaDB : message de MariaDB rendu, fichier retiré quand même", async () => {
    const c = cluster((file, args) =>
      file === "/usr/bin/mariadb" && args[0]?.startsWith("--defaults-extra-file") ? { code: 1, stdout: "", stderr: "ERROR 1044 (42000) at line 1: Access denied for user to database 'autre'" } : { code: 0, stdout: "", stderr: "" },
    );
    c.m.nodes.set("/etc/passwd", { type: "file", text: PASSWD });
    await c.ops.upsert(spec);
    await c.ops.createDb("mytakumi");
    c.m.nodes.set("/srv/sites/mytakumi/incoming/b.sql", { type: "file", text: "USE autre; DROP TABLE x;" });
    await expect(c.ops.importDb("mytakumi", "/srv/sites/mytakumi/incoming/b.sql", false)).rejects.toThrow(/Import refusé par MariaDB : ERROR 1044/);
    expect(c.m.nodes.has("/srv/sites/mytakumi/incoming/b.sql")).toBe(false);
  });

  it("CT reconstruit (perte du CT) : nouveau compte, import de la sauvegarde du hub, .env avec les nouveaux DB_*", async () => {
    const first = await site();
    await first.ops.createDb("mytakumi");
    const oldPassword = /^password=(\S+)$/m.exec(text(first.m, "/etc/kouziaphp/sites/mytakumi.db.cnf")!)![1]!;

    // CT neuf : rien de l'ancien (ni fichier de compte, ni base). Le hub recrée le site puis la base, et importe.
    const fresh = await site();
    await fresh.ops.setEnv("mytakumi", { APP_ENV: "production" });
    await fresh.ops.createDb("mytakumi");
    fresh.m.nodes.set("/srv/sites/mytakumi/incoming/sauvegarde.sql.gz", { type: "file", text: "dump de la sauvegarde du hub" });
    await fresh.ops.importDb("mytakumi", "/srv/sites/mytakumi/incoming/sauvegarde.sql.gz", true);
    const newPassword = /^password=(\S+)$/m.exec(text(fresh.m, "/etc/kouziaphp/sites/mytakumi.db.cnf")!)![1]!;
    expect(newPassword).not.toBe(oldPassword);
    const env = text(fresh.m, "/srv/sites/mytakumi/.env")!;
    expect(env).toContain(`DB_PASSWORD="${newPassword}"`);
    expect(env).toContain('APP_ENV="production"');
    expect(fresh.m.inputs.find((i) => i.io.inputFile)).toMatchObject({ io: { inputFile: "/srv/sites/mytakumi/incoming/sauvegarde.sql.gz", gunzip: true }, input: "dump de la sauvegarde du hub" });
  });

  it("suppression : base et compte MariaDB retirés, fichiers de compte et de variables effacés", async () => {
    const { m, ops } = await site();
    await ops.createDb("mytakumi");
    await ops.setEnv("mytakumi", { APP_ENV: "production" });
    m.inputs.length = 0;
    await ops.remove("mytakumi");
    expect(m.inputs[0]!.input).toBe("DROP DATABASE IF EXISTS `s_mytakumi`;\nDROP USER IF EXISTS 's_mytakumi'@'localhost';");
    expect(m.nodes.has("/etc/kouziaphp/sites/mytakumi.db.cnf")).toBe(false);
    expect(m.nodes.has("/etc/kouziaphp/sites/mytakumi.env.json")).toBe(false);
  });
});

describe("script du projet", () => {
  it("lancé sous le compte du site, dans la version servie, open_basedir du site ; sortie sans les valeurs du .env", async () => {
    const c = cluster((file) => (file === "/usr/bin/php83" ? { code: 0, stdout: "Migration 001 appliquée\nDSN mot-de-passe-tres-secret\n", stderr: "" } : { code: 0, stdout: "", stderr: "" }));
    c.m.nodes.set("/etc/passwd", { type: "file", text: PASSWD });
    await c.ops.upsert(spec);
    await c.ops.setEnv("mytakumi", { APP_KEY: "mot-de-passe-tres-secret" });
    await expect(c.ops.runScript("mytakumi", "scripts/migrate.php")).rejects.toThrow(/publier le site d'abord/);
    c.m.nodes.set("/srv/sites/mytakumi/releases/1", { type: "dir" });
    await c.ops.publish("mytakumi", 1);
    await expect(c.ops.runScript("mytakumi", "scripts/migrate.php")).rejects.toThrow(/Script absent/);
    c.m.nodes.set("/srv/sites/mytakumi/releases/1/scripts/migrate.php", { type: "file", text: "<?php" });
    // Le lien current est simulé par un chemin direct (le système en mémoire ne suit pas les liens).
    c.m.nodes.set("/srv/sites/mytakumi/current/scripts/migrate.php", { type: "file", text: "<?php" });
    const r = await c.ops.runScript("mytakumi", "scripts/migrate.php");
    expect(r).toMatchObject({ script: "scripts/migrate.php", code: 0, timedOut: false });
    expect(r.output).toBe("Migration 001 appliquée\nDSN ••••\n");
    const call = c.m.inputs.find((i) => i.file === "/usr/bin/php83")!;
    expect(call.io).toMatchObject({ uid: 20001, gid: 20005, cwd: "/srv/sites/mytakumi/current", timeoutMs: 120_000 });
    expect(call.args).toContain("open_basedir=/srv/sites/mytakumi/");
    expect(call.args).toContain("memory_limit=1024M");
    // Fonctions coupées comme pour les pages, même si la configuration commune n'était pas lue (revue de l'agent).
    expect(call.args).toContain("disable_functions=exec,passthru,shell_exec,system,proc_open,popen,pcntl_exec,dl");
    expect(call.args.at(-1)).toBe("scripts/migrate.php");
    // create-admin.php : arguments, mot de passe sur l'entrée standard (jamais en argument), masqué dans la sortie.
    c.m.nodes.set("/srv/sites/mytakumi/current/scripts/create-admin.php", { type: "file", text: "<?php" });
    c.m.inputs.length = 0;
    await c.ops.runScript("mytakumi", "scripts/create-admin.php", ["alexandre@kouzia.fr"], "Mot-de-passe-admin-1\n");
    const admin = c.m.inputs.find((i) => i.file === "/usr/bin/php83")!;
    expect(admin.args.slice(-2)).toEqual(["scripts/create-admin.php", "alexandre@kouzia.fr"]);
    expect(admin.input).toBe("Mot-de-passe-admin-1\n");
    expect(c.m.runs.join("\n")).not.toContain("Mot-de-passe-admin-1");
    await expect(c.ops.runScript("mytakumi", "scripts/create-admin.php", ["a\0b"])).rejects.toThrow(/Arguments/);
    await expect(c.ops.runScript("mytakumi", "scripts/create-admin.php", [], "x".repeat(5000))).rejects.toThrow(/Entrée standard/);
    for (const bad of ["../etc/passwd.php", "/root/x.php", "scripts/migrate.sh", "scripts/.hidden.php", 3]) {
      await expect(c.ops.runScript("mytakumi", bad), String(bad)).rejects.toThrow(/Script attendu|Dossier invalide/);
    }
  });
});

describe("tâche planifiée et journaux (lot P5)", () => {
  async function cronSite(cron: unknown) {
    const c = cluster();
    c.m.nodes.set("/etc/passwd", { type: "file", text: PASSWD });
    await c.ops.upsert({ ...spec, cron });
    return c;
  }

  it("crontab du compte du site posée, crond prévenu ; fréquences et durées maximales ; réglages douteux refusés", async () => {
    const { m } = await cronSite({ script: "scripts/cron.php", every: "15m" });
    expect(text(m, "/etc/crontabs/php-mytakumi")).toMatch(/\n\*\/15 \* \* \* \* \/usr\/local\/lib\/kouziaphp\/cron-run mytakumi scripts\/cron\.php 720\n$/);
    expect(text(m, "/etc/crontabs/cron.update")).toContain("php-mytakumi\n");
    // Horaire et quotidienne : minute fixe tirée du site (étalement), même minute à chaque fois.
    expect(cronLine("mytakumi", { script: "scripts/cron.php", every: "1h" })).toMatch(/^\d{1,2} \* \* \* \* .* 3000$/);
    expect(cronLine("mytakumi", { script: "scripts/cron.php", every: "1d" })).toMatch(/^\d{1,2} 3 \* \* \* .* 7200$/);
    for (const [cron, msg] of [
      [{ script: "../x.php", every: "15m" }, /Dossier invalide/],
      [{ script: "scripts/cron.sh", every: "15m" }, /Script attendu/],
      [{ script: "scripts/cron.php", every: "2m" }, /Fréquence/],
    ] as const) {
      expect(() => checkCron(cron), JSON.stringify(cron)).toThrow(msg);
    }
  });

  it("coupée avec le site, remise au rallumage ; retirée à la suppression ; aucune sans réglage", async () => {
    const { m, ops } = await cronSite({ script: "scripts/cron.php", every: "5m" });
    await ops.setEnabled("mytakumi", false);
    expect(m.nodes.has("/etc/crontabs/php-mytakumi")).toBe(false);
    // Réglage reposé pendant que le site est coupé : toujours pas de crontab.
    await ops.upsert({ ...spec, cron: { script: "scripts/cron.php", every: "5m" } });
    expect(m.nodes.has("/etc/crontabs/php-mytakumi")).toBe(false);
    await ops.setEnabled("mytakumi", true);
    expect(text(m, "/etc/crontabs/php-mytakumi")).toContain("*/5 * * * *");
    await ops.upsert({ ...spec, cron: null });
    expect(m.nodes.has("/etc/crontabs/php-mytakumi")).toBe(false);
    await ops.upsert({ ...spec, cron: { script: "scripts/cron.php", every: "5m" } });
    await ops.remove("mytakumi");
    expect(m.nodes.has("/etc/crontabs/php-mytakumi")).toBe(false);
  });

  it("dernier passage et sortie lus sous le compte du site, valeurs du .env masquées ; journaux bornés", async () => {
    const { m, ops } = await cronSite({ script: "scripts/cron.php", every: "15m" });
    await ops.setEnv("mytakumi", { APP_KEY: "cle-secrete-123456" });
    m.nodes.set("/srv/sites/mytakumi/logs/cron-last.json", { type: "file", text: '{"start":"2026-10-26T10:15:00Z","durationSec":3,"code":0,"timedOut":false,"skipped":false}\n' });
    m.nodes.set("/srv/sites/mytakumi/logs/cron-last.out", { type: "file", text: "Outbox : 2 e-mails\nclé cle-secrete-123456\n" });
    const state = await ops.cronState("mytakumi");
    expect(state).toMatchObject({ cron: { script: "scripts/cron.php", every: "15m" }, active: true, maxSec: 720, last: { code: 0, durationSec: 3, skipped: false } });
    expect(state.output).toBe("Outbox : 2 e-mails\nclé ••••\n");
    const tail = m.inputs.find((i) => i.file === "/usr/bin/tail")!;
    expect(tail.io).toMatchObject({ uid: 20001, gid: 20005 });

    m.nodes.set("/srv/sites/mytakumi/logs/php-errors.log", { type: "file", text: Array.from({ length: 300 }, (_, i) => `ligne ${i + 1}`).join("\n") });
    const log = await ops.logs("mytakumi", "php", 2);
    expect(log.text).toBe("ligne 299\nligne 300\n");
    await expect(ops.logs("mytakumi", "shadow", 10)).rejects.toThrow(/Journal inconnu/);
    await expect(ops.logs("mytakumi", "php", 5000)).rejects.toThrow(/de 1 à 2000/);
    // Pas encore de passage : null, sans erreur.
    m.nodes.delete("/srv/sites/mytakumi/logs/cron-last.json");
    expect((await ops.cronState("mytakumi")).last).toBeNull();
  });
});

describe("sortie réseau par site (lot P5) : relève IMAP et HTTPS", () => {
  it("listes d'UID recalculées ; pare-feu reposé seulement si elles changent ; refermées quand le site est coupé ou retiré", async () => {
    const { m, ops } = cluster();
    const net = (f: string) => text(m, `/etc/kouziaphp/net/${f}`) ?? "";
    const firewall = () => m.runs.filter((r) => r === "/bin/sh /usr/local/lib/kouziaphp/firewall.sh").length;
    await ops.upsert({ ...spec, imapOpen: true });
    await ops.upsert({ ...spec, slug: "boutique", hostname: "boutique.kouzia.com", publicPersistentDirs: [], httpsOpen: false });
    const uid = (slug: string) => text(m, "/etc/passwd")!.split("\n").find((l) => l.startsWith(`php-${slug}:`))!.split(":")[2];
    expect(net("imap-open")).toBe(`${uid("mytakumi")}\n`);
    expect(net("https-closed")).toBe(`${uid("boutique")}\n`);
    const before = firewall();
    expect(before).toBe(2);

    // Même réglage : rien ne change, pare-feu non relancé.
    await ops.upsert({ ...spec, imapOpen: true });
    expect(firewall()).toBe(before);

    // Site coupé : 993 refermé, 443 fermé aussi ; rallumé : selon ses réglages.
    await ops.setEnabled("mytakumi", false);
    expect(net("imap-open")).toBe("");
    expect(net("https-closed").split("\n").filter(Boolean).sort()).toEqual([uid("boutique"), uid("mytakumi")].sort());
    await ops.setEnabled("mytakumi", true);
    expect(net("imap-open")).toBe(`${uid("mytakumi")}\n`);
    expect(net("https-closed")).toBe(`${uid("boutique")}\n`);

    // Interrupteur coupé dans le hub : refermé.
    await ops.upsert({ ...spec, imapOpen: false });
    expect(net("imap-open")).toBe("");
    expect(firewall()).toBe(before + 3);

    // Pare-feu refusé par le CT : erreur dite, pas de silence.
    const failing = cluster((file, args) => (file === "/bin/sh" ? { code: 1, stdout: "", stderr: "nftables refusé" } : file === "/sbin/rc-service" && args[1] === "status" ? { code: 3, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" }));
    await expect(failing.ops.upsert({ ...spec, imapOpen: true })).rejects.toThrow(/Pare-feu du CT .*nftables refusé/);
  });
});

describe("page du site pour la vignette (lot P5)", () => {
  it("lue sur nginx local sous le nom du site ; chemin contrôlé ; sans lecteur : 503", async () => {
    const m = memorySys();
    const asked: string[] = [];
    const httpGet = async (host: string, p: string, max: number) => {
      asked.push(`${host} ${p} ${max}`);
      return { status: 200, contentType: "text/html", location: null, body: Buffer.from("<h1>Boutique</h1>") };
    };
    const ops = siteOperations({ ...ctx, paths, limitsEffective: () => true, httpStatus: async () => 403, httpGet, sys: m.sys });
    await ops.upsert(spec);
    const r = await ops.page("mytakumi", "/oeuvres?page=2");
    expect(r).toEqual({ status: 200, contentType: "text/html", location: null, body: Buffer.from("<h1>Boutique</h1>").toString("base64") });
    expect(asked).toEqual(["mytakumi.kouzia.com /oeuvres?page=2 8388608"]);
    for (const bad of ["oeuvres", "/a b", "/a\nHost: x", "", "http://autre/"]) await expect(ops.page("mytakumi", bad)).rejects.toThrow(/Chemin de page invalide/);
    await expect(ops.page("inconnu", "/")).rejects.toThrow(/Site inconnu/);
    const without = siteOperations({ ...ctx, paths, limitsEffective: () => true, httpStatus: async () => 403, sys: m.sys });
    await expect(without.page("mytakumi", "/")).rejects.toMatchObject({ status: 503 });
  });
});

describe("PHP en ligne de commande d'un site : mêmes fonctions coupées que les pages (revue de l'agent)", () => {
  it("install.sh (PHP-FPM et CLI), cron-run et le script lancé depuis le hub coupent la même liste", () => {
    const root = join(import.meta.dirname, "../../../../../scripts/php-ct");
    const list = DISABLED_FUNCTIONS;
    expect(readFileSync(join(root, "install.sh"), "utf8")).toContain(`disable_functions = ${list}`);
    expect(readFileSync(join(root, "cron-run"), "utf8")).toContain(`-d "disable_functions=${list}"`);
  });
});
