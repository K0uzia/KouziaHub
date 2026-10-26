import { describe, expect, it } from "vitest";
import {
  checkEnvVars,
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
    expect(block![2]).toContain("try_files $uri =404;");
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
    // Rendus au compte du site, sans suivre de lien, AVANT la création sous son compte.
    const fixedPublic = m.runs.indexOf("/bin/chown -h php-mytakumi:php-mytakumi /srv/sites/mytakumi/shared/public");
    const fixedAssets = m.runs.indexOf("/bin/chown -h php-mytakumi:php-mytakumi /srv/sites/mytakumi/shared/public/assets");
    const mkdirAsSite = m.runs.indexOf("/bin/mkdir -p /srv/sites/mytakumi/shared/public/assets/img/oeuvres");
    expect(fixedPublic).toBeGreaterThanOrEqual(0);
    expect(fixedAssets).toBeGreaterThan(fixedPublic);
    expect(mkdirAsSite).toBeGreaterThan(fixedAssets);
    expect(m.runs).toContain("/bin/chmod 750 /srv/sites/mytakumi/shared/public");
    expect(text(m, "/srv/sites/mytakumi/shared/public/assets/img/oeuvres/vase.webp")).toBe("vase");
    // Republication : déjà au compte du site, rien à reprendre.
    m.runs.length = 0;
    await ops.publish("mytakumi", 1);
    expect(m.runs.some((r) => r.startsWith("/bin/chown -h"))).toBe(false);

    // Le site a remplacé un parent par un lien vers ailleurs : refus, root ne touche à rien au-delà.
    m.nodes.set("/srv/sites/mytakumi/shared/public/assets", { type: "link", target: "/etc" });
    m.runs.length = 0;
    await expect(ops.publish("mytakumi", 1)).rejects.toThrow(/est un lien, refusé/);
    // (data/, traité avant, n'est pas en cause.)
    expect(m.runs.some((r) => (r.startsWith("/bin/chown") || r.startsWith("/bin/mkdir")) && r.includes("/shared/public"))).toBe(false);
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
    expect(m.inputs[imported]).toMatchObject({ args: ["--defaults-extra-file=/etc/kouziaphp/sites/mytakumi.db.cnf", "s_mytakumi"], io: { inputFile: "/srv/sites/mytakumi/dumps/6.sql.gz", gunzip: true } });
    await expect(ops.restoreDump("mytakumi", 1)).rejects.toThrow(/Pas de dump/);
  });

  it("import avec le compte du site (fichier retiré ensuite), export compressé ; sans base : refus clair", async () => {
    const { m, ops } = await site();
    m.nodes.set("/srv/sites/mytakumi/incoming/a.sql", { type: "file", text: "CREATE TABLE t (id INT);" });
    await expect(ops.importDb("mytakumi", "/srv/sites/mytakumi/incoming/a.sql", false)).rejects.toThrow(/créer d'abord/);
    await ops.createDb("mytakumi");
    m.inputs.length = 0;
    await ops.importDb("mytakumi", "/srv/sites/mytakumi/incoming/a.sql", false);
    expect(m.inputs[0]).toMatchObject({ file: "/usr/bin/mariadb", args: ["--defaults-extra-file=/etc/kouziaphp/sites/mytakumi.db.cnf", "s_mytakumi"], input: "CREATE TABLE t (id INT);" });
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
