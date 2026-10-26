import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PhpCronView, PhpDbView, PhpEnvView, PhpScriptRun, PhpScriptsView, PhpServerStatus, SiteDetail } from "@/contract.js";
import { backupPhpDatabases, PHP_DUMPS_KEPT_DAYS, phpDumpsDir } from "@/lib/php-app.js";
import { PhpAgentClient } from "@/lib/php-agent/client.js";
import { createAgent, type Probes } from "../../../../../scripts/php-ct/agent/agent.mjs";
import { siteOperations, type Paths } from "../../../../../scripts/php-ct/agent/sites.mjs";
import { prisma, resetDb } from "../helpers/db.js";
import { buildTestHub, settle, uploadFiles, type TestHub } from "../helpers/hub.js";
import { memorySys } from "../helpers/php-memory.js";

// Lot P4 de bout en bout (docs/cadrage.md, 11.5) : le vrai hub, le vrai agent (serveur et client signés), ses
// opérations sur un système en mémoire. Les fichiers échangés (import, export) passent par un vrai disque.
const SECRET = "s".repeat(48);
const TUNNEL = "6ff42ae2-765d-4adf-8112-31c55c1551ef";
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
const DUMP = "-- dump de la base\nCREATE TABLE settings (k VARCHAR(190) PRIMARY KEY);\n";

let hub: TestHub;
let server: Server;
let mem: ReturnType<typeof memorySys>;
const disk = mkdtempSync(join(tmpdir(), "kouzia-php-p4-"));

beforeEach(async () => {
  await resetDb();
  mem = memorySys((file, args) => {
    if (file === "/bin/tar" && args[0] === "-tvzf") return { code: 0, stdout: "-rw-r--r-- 0/0 1 2026-10-25 10:00 public/index.php\n", stderr: "" };
    if (file === "/usr/bin/php83") return { code: 0, stdout: "Migrations : 7 appliquées.\n", stderr: "" };
    // État de la base : taille et nombre de tables lus par root.
    if (file === "/usr/bin/mariadb" && args[0] === "--batch") return { code: 0, stdout: "65536\t9\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const ops = siteOperations({ paths, domain: "kouzia.com", phpInstalled: () => ["8.3"], limitsEffective: () => true, httpStatus: async () => 404, sys: mem.sys });
  const probes = {
    alpine: () => "3.22.2",
    php: () => ["8.3"],
    service: async () => "running",
    cgroups: () => ({ result: "ok", checkedAt: null }),
    lastUpgrade: () => "2026-10-25",
    disk: () => null,
    memory: () => 3 * 1024 ** 3,
    sites: () => 0,
    tunnelId: () => TUNNEL,
    now: () => Date.now(),
  } satisfies Probes;
  // Fichiers reçus (import) écrits sur le vrai disque ; export : un vrai fichier .sql.gz rendu par l'agent.
  server = createAgent({
    secret: SECRET,
    allowedIps: ["127.0.0.1"],
    probes,
    sites: {
      ...ops,
      incomingFile: async (slug, nonce, kind) => (await ops.incomingFile(slug, nonce, kind), join(disk, `${nonce}.${kind === "version" ? "tar.gz" : kind === "sqlgz" ? "sql.gz" : "sql"}`)),
      exportDb: async (slug) => {
        await ops.exportDb(slug);
        const file = join(disk, `export-${Date.now()}-${Math.random().toString(16).slice(2)}.sql.gz`);
        writeFileSync(file, gzipSync(DUMP));
        return { file };
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const agent = new PhpAgentClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, secret: SECRET });
  hub = await buildTestHub({ phpAgent: agent });
});
afterEach(async () => {
  await hub.app.close();
  await new Promise((resolve) => server.close(resolve));
});

const create = (php: Record<string, unknown> = {}) =>
  hub.app.inject({
    method: "POST",
    url: "/api/sites",
    headers: hub.headers,
    payload: { kind: "PERSO", slug: "mytakumi", label: "MyTakumi", hosting: "php", php: { persistentDirs: ["data"], ...php } },
  });
const call = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) => hub.app.inject({ method, url, headers: hub.headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const text = (p: string) => (mem.nodes.get(p) as { text?: string } | undefined)?.text ?? null;

async function site(php: Record<string, unknown> = {}): Promise<string> {
  const res = await create(php);
  expect(res.statusCode, res.body).toBe(201);
  await settle(hub);
  mem.nodes.set("/etc/passwd", { type: "file", text: `${text("/etc/passwd")}php-mytakumi:x:20001:20001::/srv/sites/mytakumi:/sbin/nologin\n` });
  return (res.json() as SiteDetail).id;
}

describe("réglages d'un site PHP (création et après)", () => {
  it("création avec dossiers publics et limites ; changement posé sur le CT puis gardé ; réglage douteux refusé sans rien changer", async () => {
    const id = await site({ publicPersistentDirs: ["public/assets/img/oeuvres"], memoryLimitMb: 1024, uploadMaxMb: 100, maxExecutionSec: 120 });
    const detail = (await call("GET", `/api/sites/${id}`)).json() as SiteDetail;
    expect(detail.php).toMatchObject({ publicPersistentDirs: ["public/assets/img/oeuvres"], memoryLimitMb: 1024, uploadMaxMb: 100, maxExecutionSec: 120 });
    expect(text("/etc/kouziaphp/fpm/mytakumi.conf")).toContain("php_admin_value[memory_limit] = 1024M");
    expect(text("/etc/conf.d/kouziaphp-site.mytakumi")).toContain("memory.max 1280M");

    const patched = await call("PATCH", `/api/sites/${id}/php`, { memoryLimitMb: 512, maxExecutionSec: 60 });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((patched.json() as SiteDetail).php).toMatchObject({ memoryLimitMb: 512, maxExecutionSec: 60, uploadMaxMb: 100 });
    expect(text("/etc/kouziaphp/fpm/mytakumi.conf")).toContain("php_admin_value[max_execution_time] = 60");
    // Réglages de PHP changés, service en marche : redémarré pour les appliquer.
    expect(mem.runs).toContain("/sbin/rc-service kouziaphp-site.mytakumi restart");

    const bad = await call("PATCH", `/api/sites/${id}/php`, { publicPersistentDirs: ["assets/hors-public"] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "php_settings" });
    expect((await prisma.site.findUniqueOrThrow({ where: { id } })).phpPublicPersistentDirs).toBe("public/assets/img/oeuvres");
    expect((await call("PATCH", `/api/sites/${id}/php`, { memoryLimitMb: 2048 })).statusCode).toBe(400);

    // Somme des plafonds de mémoire (requête + 256 Mo) rendue avec l'état du serveur.
    const server = (await call("GET", "/api/php/serveur")).json() as PhpServerStatus;
    expect(server).toMatchObject({ reachable: true, sitesMemoryMb: 768, state: { memoryBytes: 3 * 1024 ** 3 } });
  });
});

describe("envoi d'un site PHP : limite par fichier propre (pas celle de Cloudflare Pages)", () => {
  it("fichier de 30 Mio gardé sur un site PHP ; refusé sur un site statique, avec la raison", async () => {
    const id = await site();
    const big = Buffer.alloc(30 * 1024 * 1024, 7);
    const sent = await uploadFiles(hub, id, [{ filename: "src/produit/original-48mpx.jpg", content: big }]);
    expect(sent.json()).toMatchObject({ accepted: ["src/produit/original-48mpx.jpg"], rejected: [] });
    const limits = ((await call("GET", `/api/sites/${id}/files`)).json() as { limits: { maxFileBytes: number } }).limits;
    expect(limits.maxFileBytes).toBe(256 * 1024 * 1024);

    const statique = await hub.app.inject({ method: "POST", url: "/api/sites", headers: hub.headers, payload: { kind: "PERSO", slug: "vitrine", label: "Vitrine" } });
    await settle(hub);
    const refused = await uploadFiles(hub, (statique.json() as SiteDetail).id, [{ filename: "images/original.jpg", content: big }]);
    expect(refused.json()).toMatchObject({ accepted: [], rejected: [{ path: "images/original.jpg", reason: expect.stringMatching(/^Fichier de 30,0 Mio : au-delà de 25 Mio, la limite de Cloudflare Pages/) }] });
  });
});

describe("fichiers lourds jamais servis et « Ne pas envoyer »", () => {
  it("signalés par dossier ; aperçu puis exclusion confirmée (retirés du hub) ; refusés ensuite avec la raison ; liste modifiable", async () => {
    const id = await site({ publicPersistentDirs: ["public/assets/img/oeuvres"] });
    const mb = (n: number) => Buffer.alloc(n * 1024 * 1024 + 1, 1);
    await uploadFiles(hub, id, [
      { filename: "public/index.php", content: "<?php" },
      { filename: "public/assets/img/oeuvres/vase-1600.webp", content: mb(2) },
      { filename: "data/originaux/vase.jpg", content: mb(3) },
      { filename: "src/produit/vase.jpg", content: mb(4) },
      { filename: "src/produit/bol.jpg", content: mb(5) },
      { filename: "src/App.php", content: Buffer.alloc(2 * 1024 * 1024, 32) },
    ]);
    type Files = { heavyUnserved?: Array<{ dir: string; count: number; bytes: number }>; files: Array<{ path: string }> };
    const files = (await call("GET", `/api/sites/${id}/files`)).json() as Files;
    // Ni le dossier public, ni les dossiers persistants, ni le code : seuls les originaux de src/produit/.
    expect(files.heavyUnserved).toEqual([{ dir: "src/produit/", count: 2, bytes: 9 * 1024 * 1024 + 2 }]);

    const preview = await call("GET", `/api/sites/${id}/php/exclusions/apercu?path=${encodeURIComponent("src/produit/")}`);
    expect(preview.json()).toEqual({ path: "src/produit/", count: 2, bytes: 9 * 1024 * 1024 + 2 });
    const done = await call("POST", `/api/sites/${id}/php/exclusions`, { path: "src/produit/" });
    expect(done.json()).toEqual({ excludedPaths: ["src/produit/"], removed: 2, bytes: 9 * 1024 * 1024 + 2 });
    const after = (await call("GET", `/api/sites/${id}/files`)).json() as Files;
    expect(after.files.map((f) => f.path)).not.toContain("src/produit/vase.jpg");
    expect(after.files.map((f) => f.path)).toContain("src/App.php");
    expect(after.heavyUnserved).toEqual([]);
    expect(((await call("GET", `/api/sites/${id}`)).json() as SiteDetail).php?.excludedPaths).toEqual(["src/produit/"]);

    // Envoi suivant : refusé, jamais en silence.
    const again = await uploadFiles(hub, id, [{ filename: "src/produit/tasse.jpg", content: "x" }]);
    expect(again.json()).toMatchObject({ accepted: [], rejected: [{ path: "src/produit/tasse.jpg", reason: expect.stringMatching(/^Exclu par le réglage du site/) }] });

    // Liste vidée dans les réglages : l'envoi repasse.
    expect((await call("PATCH", `/api/sites/${id}/php`, { excludedPaths: [] })).statusCode).toBe(200);
    expect((await uploadFiles(hub, id, [{ filename: "src/produit/tasse.jpg", content: "x" }])).json()).toMatchObject({ accepted: ["src/produit/tasse.jpg"] });
    for (const bad of [["src/*.jpg"], ["../etc/"]]) {
      expect((await call("PATCH", `/api/sites/${id}/php`, { excludedPaths: bad })).json(), JSON.stringify(bad)).toMatchObject({ code: "php_excluded" });
    }
  });
});

describe("tâche planifiée et journaux (lot P5)", () => {
  it("réglée dans la fiche, posée sur le CT ; dernier passage et journaux lus ; réglage douteux refusé sans rien changer", async () => {
    const id = await site();
    const set = await call("PATCH", `/api/sites/${id}/php`, { cron: { script: "scripts/cron.php", every: "15m" } });
    expect(set.statusCode, set.body).toBe(200);
    expect((set.json() as SiteDetail).php?.cron).toEqual({ script: "scripts/cron.php", every: "15m" });
    expect(text("/etc/crontabs/php-mytakumi")).toContain("/usr/local/lib/kouziaphp/cron-run mytakumi scripts/cron.php 720");

    expect((await call("PATCH", `/api/sites/${id}/php`, { cron: { script: "../../etc/x.php", every: "15m" } })).json()).toMatchObject({ code: "php_cron" });
    expect((await call("PATCH", `/api/sites/${id}/php`, { cron: { script: "scripts/cron.php", every: "1m" } })).json()).toMatchObject({ code: "php_cron" });
    expect((await prisma.site.findUniqueOrThrow({ where: { id } })).phpCronEvery).toBe("15m");

    mem.nodes.set("/srv/sites/mytakumi/logs/cron-last.json", { type: "file", text: '{"start":"2026-10-26T10:15:00Z","durationSec":2,"code":1,"timedOut":false,"skipped":false}\n' });
    mem.nodes.set("/srv/sites/mytakumi/logs/cron-last.out", { type: "file", text: "Erreur : boîte IMAP injoignable\n" });
    const cron = (await call("GET", `/api/sites/${id}/php/cron`)).json() as PhpCronView;
    expect(cron).toMatchObject({ active: true, maxSec: 720, last: { code: 1 }, output: "Erreur : boîte IMAP injoignable\n" });

    mem.nodes.set("/srv/sites/mytakumi/logs/nginx-error.log", { type: "file", text: "a\nb\nc\n" });
    expect((await call("GET", `/api/sites/${id}/php/journaux/nginx?lignes=2`)).json()).toEqual({ kind: "nginx", text: "b\nc\n" });
    expect((await call("GET", `/api/sites/${id}/php/journaux/shadow`)).statusCode).toBe(404);

    // Tâche retirée : plus de crontab.
    await call("PATCH", `/api/sites/${id}/php`, { cron: null });
    expect(mem.nodes.has("/etc/crontabs/php-mytakumi")).toBe(false);
  });
});

describe("variables d'environnement", () => {
  it("propositions ; enregistrement chiffré dans le hub, .env posé sur le CT ; clé live et DB_* refusées sans rien changer", async () => {
    const id = await site();
    const initial = (await call("GET", `/api/sites/${id}/php/variables`)).json() as PhpEnvView;
    expect(initial.vars).toEqual([]);
    expect(initial.db).toBeNull();
    expect(initial.suggestions.map((s) => [s.name, s.value])).toEqual([
      ["APP_ENV", "production"],
      ["APP_URL", "https://mytakumi.kouzia.com"],
      ["MAIL_CATCHER", "127.0.0.1:1025"],
    ]);

    const saved = await call("PUT", `/api/sites/${id}/php/variables`, {
      vars: [
        { name: "APP_ENV", value: "production" },
        { name: "APP_KEY", value: "a".repeat(64) },
        { name: "MAIL_CATCHER", value: "127.0.0.1:1025" },
      ],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((saved.json() as PhpEnvView).suggestions.map((s) => s.name)).toEqual(["APP_URL"]);
    const raw = (await prisma.site.findUniqueOrThrow({ where: { id } })).phpEnv!;
    expect(raw).not.toContain("a".repeat(64));
    expect(text("/srv/sites/mytakumi/.env")).toContain(`APP_KEY="${"a".repeat(64)}"`);
    const logged = await prisma.auditEvent.findFirstOrThrow({ where: { action: "site.php.env" } });
    expect(logged.detail).toBe("APP_ENV, APP_KEY, MAIL_CATCHER");

    for (const vars of [[{ name: "STRIPE_SECRET", value: "sk_live_51abc" }], [{ name: "DB_PASSWORD", value: "x" }], [{ name: "A", value: "1" }, { name: "A", value: "2" }]]) {
      const res = await call("PUT", `/api/sites/${id}/php/variables`, { vars });
      expect(res.statusCode, JSON.stringify(vars)).toBe(400);
    }
    expect((await prisma.site.findUniqueOrThrow({ where: { id } })).phpEnv).toBe(raw);

    // Base créée : DB_* montrées en lecture seule, mot de passe masqué.
    await call("POST", `/api/sites/${id}/php/base`);
    const withDb = (await call("GET", `/api/sites/${id}/php/variables`)).json() as PhpEnvView;
    expect(withDb.db?.find((v) => v.name === "DB_DSN")?.value).toBe("mysql:unix_socket=/run/mysqld/mysqld.sock;dbname=s_mytakumi;charset=utf8mb4");
    expect(withDb.db?.find((v) => v.name === "DB_PASSWORD")?.value).toBe("••••••••");
  });
});

describe("base du site", () => {
  it("création, import en flux (.sql et .sql.gz), export signé, réinitialisation avec confirmation", async () => {
    const id = await site();
    expect(((await call("GET", `/api/sites/${id}/php/base`)).json() as PhpDbView).exists).toBe(false);
    const created = await call("POST", `/api/sites/${id}/php/base`);
    expect(created.json()).toMatchObject({ exists: true, name: "s_mytakumi", bytes: 65536, tables: 9 });

    const imp = await hub.app.inject({ method: "PUT", url: `/api/sites/${id}/php/base/import`, headers: { ...hub.headers, "content-type": "application/sql" }, payload: DUMP });
    expect(imp.statusCode, imp.body).toBe(200);
    const sent = mem.inputs.find((i) => i.io.inputFile)!;
    expect(sent.io.gunzip).toBe(false);
    expect(readFileSync(sent.io.inputFile!, "utf8")).toBe(DUMP);

    const impGz = await hub.app.inject({ method: "PUT", url: `/api/sites/${id}/php/base/import`, headers: { ...hub.headers, "content-type": "application/gzip" }, payload: gzipSync(DUMP) });
    expect(impGz.statusCode, impGz.body).toBe(200);
    expect(mem.inputs.filter((i) => i.io.inputFile).at(-1)!.io.gunzip).toBe(true);
    expect((await hub.app.inject({ method: "PUT", url: `/api/sites/${id}/php/base/import`, headers: { ...hub.headers, "content-type": "text/plain" }, payload: DUMP })).statusCode).toBe(415);

    const exp = await call("GET", `/api/sites/${id}/php/base/export`);
    expect(exp.statusCode).toBe(200);
    expect(exp.headers["content-disposition"]).toMatch(/^attachment; filename="mytakumi-base-\d{4}-\d{2}-\d{2}\.sql\.gz"$/);
    expect(gunzipSync(exp.rawPayload).toString("utf8")).toBe(DUMP);

    expect((await call("POST", `/api/sites/${id}/php/base/reinitialiser`, { confirm: "autre" })).statusCode).toBe(400);
    expect((await call("POST", `/api/sites/${id}/php/base/reinitialiser`, { confirm: "mytakumi" })).statusCode).toBe(200);
    expect(mem.inputs.some((i) => i.input === "DROP DATABASE IF EXISTS `s_mytakumi`;")).toBe(true);
  });

  it("publication : variables reposées et dump pris avant la bascule ; restauration du dump de la version", async () => {
    const id = await site();
    await call("PUT", `/api/sites/${id}/php/variables`, { vars: [{ name: "APP_ENV", value: "production" }] });
    await call("POST", `/api/sites/${id}/php/base`);
    // CT reconstruit entre-temps : plus de .env. La publication le repose.
    mem.nodes.delete("/srv/sites/mytakumi/.env");
    mem.nodes.delete("/etc/kouziaphp/sites/mytakumi.env.json");
    await uploadFiles(hub, id, [{ filename: "public/index.php", content: "<?php echo 1;" }]);
    expect((await call("POST", `/api/sites/${id}/publish`)).statusCode).toBeLessThan(300);
    await settle(hub);
    expect(((await call("GET", `/api/sites/${id}`)).json() as SiteDetail).currentVersion?.number).toBe(2);
    expect(text("/srv/sites/mytakumi/.env")).toContain('APP_ENV="production"');
    // Dump avant la bascule : la mise en service de la version 2 (PHP démarré ou rechargé) vient après.
    const dumpAt = mem.runs.findIndex((r) => r.startsWith("/usr/bin/mariadb-dump "));
    const switchAt = mem.runs.map((r) => /^\/sbin\/rc-service kouziaphp-site\.mytakumi (start|reload)$/.test(r)).lastIndexOf(true);
    expect(dumpAt).toBeGreaterThanOrEqual(0);
    expect(switchAt).toBeGreaterThan(dumpAt);
    expect(((await call("GET", `/api/sites/${id}/php/base`)).json() as PhpDbView).dumps).toEqual([2]);

    expect((await call("POST", `/api/sites/${id}/php/base/restaurer`, { version: 2, confirm: "x" })).statusCode).toBe(400);
    const restored = await call("POST", `/api/sites/${id}/php/base/restaurer`, { version: 2, confirm: "mytakumi" });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(mem.inputs.filter((i) => i.io.inputFile).at(-1)!.io).toMatchObject({ inputFile: "/srv/sites/mytakumi/dumps/2.sql.gz", gunzip: true });
  });

  it("sauvegarde de nuit : tirée par le hub, 14 jours gardés ; restauration sur un CT reconstruit (nouveau compte, DB_* réécrites)", async () => {
    const id = await site();
    await call("POST", `/api/sites/${id}/php/base`);
    const day = (n: number) => Date.UTC(2026, 9, n, 2, 0, 0);
    for (let n = 1; n <= 16; n++) expect(await backupPhpDatabases(hub.services, day(n))).toEqual({ saved: ["mytakumi"], failed: [] });
    const nightly = ((await call("GET", `/api/sites/${id}/php/base`)).json() as { nightly: Array<{ day: string }> }).nightly;
    expect(nightly).toHaveLength(PHP_DUMPS_KEPT_DAYS);
    expect(nightly[0]!.day).toBe("2026-10-16");
    expect(gunzipSync(readFileSync(join(phpDumpsDir(hub.services, "mytakumi"), "2026-10-16.sql.gz"))).toString("utf8")).toBe(DUMP);

    // Perte du CT : plus de compte MariaDB ni de .env sur le CT neuf.
    const oldCnf = text("/etc/kouziaphp/sites/mytakumi.db.cnf");
    mem.nodes.delete("/etc/kouziaphp/sites/mytakumi.db.cnf");
    const restored = await call("POST", `/api/sites/${id}/php/base/sauvegarde`, { day: "2026-10-16", confirm: "mytakumi" });
    expect(restored.statusCode, restored.body).toBe(200);
    const cnf = text("/etc/kouziaphp/sites/mytakumi.db.cnf")!;
    expect(cnf).not.toBe(oldCnf);
    const password = /^password=(\S+)$/m.exec(cnf)![1]!;
    expect(text("/srv/sites/mytakumi/.env")).toContain(`DB_PASSWORD="${password}"`);
    const imported = mem.inputs.filter((i) => i.io.inputFile).at(-1)!;
    expect(imported.io.gunzip).toBe(true);
    expect(gunzipSync(readFileSync(imported.io.inputFile!)).toString("utf8")).toBe(DUMP);
    expect((await call("POST", `/api/sites/${id}/php/base/sauvegarde`, { day: "2026-09-01", confirm: "mytakumi" })).statusCode).toBe(404);
  });
});

describe("scripts du projet", () => {
  it("liste de la version servie (outils d'abord) ; lancé avec arguments et entrée ; journal sans l'entrée ni les arguments", async () => {
    const id = await site();
    // Seule la page d'attente est publiée : aucun script.
    expect(((await call("GET", `/api/sites/${id}/php/scripts`)).json() as PhpScriptsView).scripts).toEqual([]);
    await uploadFiles(hub, id, [
      { filename: "public/index.php", content: "<?php" },
      { filename: "scripts/migrate.php", content: "<?php" },
      { filename: "scripts/create-admin.php", content: "<?php" },
    ]);
    await call("POST", `/api/sites/${id}/publish`);
    await settle(hub);
    const list = (await call("GET", `/api/sites/${id}/php/scripts`)).json() as PhpScriptsView;
    expect(list.scripts).toEqual(["scripts/create-admin.php", "scripts/migrate.php", "public/index.php"]);
    // Script présent dans la version servie (le lien current n'est pas suivi par le système en mémoire).
    mem.nodes.set("/srv/sites/mytakumi/current/scripts/create-admin.php", { type: "file", text: "<?php" });
    const run = await call("POST", `/api/sites/${id}/php/script`, { path: "scripts/create-admin.php", args: ["alexandre@kouzia.fr"], stdin: "Mot-de-passe-admin-1" });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json()).toMatchObject({ script: "scripts/create-admin.php", code: 0, output: "Migrations : 7 appliquées.\n" } satisfies Partial<PhpScriptRun>);
    const logged = await prisma.auditEvent.findFirstOrThrow({ where: { action: "site.php.script" } });
    expect(logged.detail).toMatch(/^scripts\/create-admin\.php : code 0, /);
    expect(JSON.stringify(await prisma.auditEvent.findMany())).not.toMatch(/Mot-de-passe-admin-1|alexandre@kouzia\.fr/);
    expect((await call("POST", `/api/sites/${id}/php/script`, { path: "scripts/autre.php" })).statusCode).toBe(404);
  });
});

describe("sortie réseau d'un site PHP (lot P5)", () => {
  it("relève IMAP ouverte puis refermée depuis le hub : posée sur le CT (pare-feu), gardée dans la fiche", async () => {
    const id = await site();
    const uid = text("/etc/passwd")!.split("\n").find((l) => l.startsWith("php-mytakumi:"))!.split(":")[2];
    const open = await call("PATCH", `/api/sites/${id}/php`, { imapOpen: true });
    expect(open.statusCode, open.body).toBe(200);
    expect((open.json() as SiteDetail).php).toMatchObject({ imapOpen: true, httpsOpen: true });
    expect(JSON.parse(text("/etc/kouziaphp/sites/mytakumi.json")!)).toMatchObject({ imapOpen: true, httpsOpen: true });
    expect(text("/etc/kouziaphp/net/imap-open")).toBe(`${uid}\n`);
    expect(mem.runs).toContain("/bin/sh /usr/local/lib/kouziaphp/firewall.sh");

    const closed = await call("PATCH", `/api/sites/${id}/php`, { imapOpen: false, httpsOpen: false });
    expect((closed.json() as SiteDetail).php).toMatchObject({ imapOpen: false, httpsOpen: false });
    expect(text("/etc/kouziaphp/net/imap-open")).toBe("");
    expect(text("/etc/kouziaphp/net/https-closed")).toBe(`${uid}\n`);
    expect((await call("PATCH", `/api/sites/${id}/php`, { imapOpen: "oui" })).statusCode).toBe(400);
  });
});
