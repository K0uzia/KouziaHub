import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent, tunnelIdOf, type Probes } from "../../../../../scripts/php-ct/agent/agent.mjs";
import { memorySys } from "../helpers/php-memory.js";
import {
  CHECK_PATHS,
  allocateUid,
  checkArchiveListing,
  checkSiteSpec,
  fpmConf,
  nginxConf,
  siteOperations,
  type Paths,
} from "../../../../../scripts/php-ct/agent/sites.mjs";

// Opérations de l'agent sur les sites PHP (docs/cadrage.md, sections 11.2 à 11.5, lot P3a). Système de fichiers
// simulé en mémoire : la logique (bascule, dossiers persistants, nettoyage) et les commandes sont vérifiées sans root.

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
// nginx simulé : tout est refusé sauf ce que le test ouvre exprès.
let served = new Set<string>();
const ctx = { domain: "kouzia.com", phpInstalled: () => ["8.3"], httpStatus: async (_host: string, p: string) => (served.has(p) ? 200 : 403) };
const spec = { slug: "mytakumi", hostname: "mytakumi.kouzia.com", php: "8.3", publicDir: "public", persistentDirs: ["data"] };

describe("réglages d'un site PHP (validation stricte, l'agent tourne en root)", () => {
  it("accepte le cas MyTakumi ; refuse slug, nom d'hôte, version de PHP et dossiers douteux", () => {
    expect(checkSiteSpec(spec, ctx)).toEqual({ ...spec, indexing: false });
    for (const [over, msg] of [
      [{ slug: "../etc" }, /Identifiant/],
      [{ hostname: "mytakumi.evil.com" }, /Nom d'hôte attendu/],
      [{ php: "8.4" }, /pas installé/],
      [{ publicDir: "../root" }, /Dossier invalide/],
      [{ publicDir: "/srv" }, /Dossier invalide/],
      [{ persistentDirs: ["public/uploads"] }, /servi/],
      [{ publicDir: "" }, /racine/],
      [{ persistentDirs: [".ssh"] }, /Dossier invalide/],
    ] as const) {
      expect(() => checkSiteSpec({ ...spec, ...over }, ctx), JSON.stringify(over)).toThrow(msg);
    }
  });

  it("UID : celui du compte s'il existe, sinon le premier libre de la plage des sites", () => {
    const passwd = "root:x:0:0::/:/bin/sh\nphp-a:x:20000:20000::/:/x\nphp-b:x:20002:20002::/:/x\nnginx:x:100:101::/:/x";
    expect(allocateUid(passwd, "php-b")).toEqual({ uid: 20002, exists: true });
    expect(allocateUid(passwd, "php-c")).toEqual({ uid: 20001, exists: false });
  });

  it("contrôle anti-fuite : chaque chemin sondé est refusé par nginx lui-même (pas de passage par PHP, réponse immédiate)", () => {
    // Première location regex qui correspond, comme nginx (ordre du fichier) ; « ~* » : sans casse.
    const rules = [...nginxConf(checkSiteSpec(spec, ctx), paths).matchAll(/^\s*location (~\*?) (\S+) \{ (.*) \}$/gm)].map((m) => ({
      re: new RegExp(m[2]!, m[1] === "~*" ? "i" : ""),
      action: m[3]!,
    }));
    expect(rules.length).toBeGreaterThan(3);
    for (const p of CHECK_PATHS) expect(rules.find((r) => r.re.test(p))?.action, p).toBe("return 403;");
  });

  it("nginx : dossier public seul, noindex, fichiers sensibles refusés, PHP par le socket du site", () => {
    const conf = nginxConf(checkSiteSpec(spec, ctx), paths);
    expect(conf).toContain("server_name mytakumi.kouzia.com;");
    expect(conf).toContain("root /srv/sites/mytakumi/current/public;");
    expect(conf).toContain('add_header X-Robots-Tag "noindex, nofollow" always;');
    expect(conf).toContain("location ~ /\\.(?!well-known/) { return 403; }");
    expect(conf).toContain("fastcgi_pass unix:/run/kouziaphp/mytakumi.sock;");
    expect(conf).toContain("$realpath_root$fastcgi_script_name");
    expect(nginxConf(checkSiteSpec({ ...spec, indexing: true }, ctx), paths)).not.toContain("noindex");
    const fpm = fpmConf(checkSiteSpec(spec, ctx), paths);
    expect(fpm).toContain("user = php-mytakumi");
    expect(fpm).toContain("php_admin_value[open_basedir] = /srv/sites/mytakumi/");
    expect(fpm).toContain("clear_env = yes");
  });

  it("archive : fichiers et dossiers seulement, chemins relatifs sûrs", () => {
    expect(checkArchiveListing("drwxr-xr-x 0/0 0 2026-10-25 10:00 ./public/\n-rw-r--r-- 0/0 12 2026-10-25 10:00 ./public/index.php\n")).toEqual(["public", "public/index.php"]);
    expect(() => checkArchiveListing("lrwxrwxrwx 0/0 0 2026-10-25 10:00 lien -> /etc/passwd")).toThrow(/lien/);
    expect(() => checkArchiveListing("-rw-r--r-- 0/0 1 2026-10-25 10:00 ../../etc/cron")).toThrow(/hors du site/);
    expect(() => checkArchiveListing("-rw-r--r-- 0/0 1 2026-10-25 10:00 /etc/cron")).toThrow(/hors du site/);
  });

  it("identifiant du tunnel lu dans son jeton, jamais le secret", () => {
    const id = "6ff42ae2-765d-4adf-8112-31c55c1551ef";
    const token = Buffer.from(JSON.stringify({ a: "compte", t: id, s: "secret-du-tunnel" })).toString("base64");
    expect(tunnelIdOf(token)).toBe(id);
    expect(tunnelIdOf("pas un jeton")).toBeNull();
    expect(tunnelIdOf(null)).toBeNull();
  });
});

describe("cycle de vie d'un site sur le CT (système simulé)", () => {
  it("création, réception, publication (dossier persistant initialisé puis gardé), retour arrière, coupure, suppression", async () => {
    const listing = "-rw-r--r-- 0/0 12 2026-10-25 10:00 ./public/index.php\n";
    const m = memorySys((file, args) => {
      if (file === "/sbin/rc-service" && args[1] === "status") return { code: 3, stdout: "", stderr: "" };
      if (file === "/bin/tar" && args[0] === "-tvzf") return { code: 0, stdout: listing, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const ops = siteOperations({ ...ctx, paths, limitsEffective: () => true, sys: m.sys });

    expect(await ops.upsert(spec)).toEqual({ slug: "mytakumi", uid: 20001, created: true });
    expect(m.runs).toContain("/usr/sbin/adduser -D -H -h /srv/sites/mytakumi -s /sbin/nologin -u 20001 php-mytakumi");
    expect(m.runs).toContain("/usr/sbin/addgroup nginx php-mytakumi");
    expect(m.owners.get("/srv/sites/mytakumi/releases")).toBe("root:php-mytakumi");
    expect(m.owners.get("/srv/sites/mytakumi/shared")).toBe("php-mytakumi:php-mytakumi");
    expect(m.nodes.get("/etc/conf.d/kouziaphp-site.mytakumi")).toMatchObject({ text: expect.stringContaining("memory.max 512M\nmemory.swap.max 0\n") });
    expect(m.nodes.get("/etc/init.d/kouziaphp-site.mytakumi")).toEqual({ type: "link", target: "/etc/init.d/kouziaphp-site" });
    expect(m.runs.slice(-2)).toEqual(["/usr/sbin/nginx -t", "/sbin/rc-service nginx reload"]);

    // Réception de la version 1 : le contenu de data/ (envoyé) est simulé après l'extraction.
    await ops.receive("mytakumi", 1, "/srv/sites/mytakumi/incoming/a.tar.gz");
    expect(m.runs).toContain("/bin/chmod -R u=rwX,g=rX,o= /srv/sites/mytakumi/releases/1");
    m.nodes.set("/srv/sites/mytakumi/releases/1/data", { type: "dir" });
    m.nodes.set("/srv/sites/mytakumi/releases/1/data/app.key", { type: "file", text: "clé" });
    await ops.publish("mytakumi", 1);
    expect(m.nodes.get("/srv/sites/mytakumi/current")).toEqual({ type: "link", target: "releases/1" });
    expect(m.nodes.get("/srv/sites/mytakumi/shared/data/app.key")).toEqual({ type: "file", text: "clé" });
    expect(m.nodes.get("/srv/sites/mytakumi/releases/1/data")).toEqual({ type: "link", target: "/srv/sites/mytakumi/shared/data" });
    expect(m.runs).toContain("/sbin/rc-service kouziaphp-site.mytakumi start");

    // Version 2 : les données de production (shared/) ne sont jamais écrasées par l'envoi.
    m.nodes.set("/srv/sites/mytakumi/shared/data/app.key", { type: "file", text: "clé de production" });
    m.nodes.set("/srv/sites/mytakumi/releases/2", { type: "dir" });
    m.nodes.set("/srv/sites/mytakumi/releases/2/data", { type: "dir" });
    m.nodes.set("/srv/sites/mytakumi/releases/2/data/app.key", { type: "file", text: "clé du poste" });
    m.nodes.set("/srv/sites/mytakumi/releases/2/public/index.php", { type: "file", text: "<?php" });
    await ops.publish("mytakumi", 2);
    expect(m.nodes.get("/srv/sites/mytakumi/shared/data/app.key")).toEqual({ type: "file", text: "clé de production" });
    expect(m.nodes.get("/srv/sites/mytakumi/current")).toEqual({ type: "link", target: "releases/2" });

    // Retour arrière : simple bascule.
    await ops.publish("mytakumi", 1);
    expect(m.nodes.get("/srv/sites/mytakumi/current")).toEqual({ type: "link", target: "releases/1" });
    await expect(ops.publish("mytakumi", 9)).rejects.toThrow(/Version absente/);

    // Versions gardées : les 5 plus récentes, la servie comprise.
    for (const n of [3, 4, 5, 6, 7]) m.nodes.set(`/srv/sites/mytakumi/releases/${n}`, { type: "dir" });
    await ops.publish("mytakumi", 1);
    const kept = (await m.sys.readdir("/srv/sites/mytakumi/releases")).sort();
    // Sept versions, la 1 servie : les cinq plus récentes (3 à 7) restent, la 1 aussi, la 2 part.
    expect(kept).toEqual(["1", "3", "4", "5", "6", "7"]);

    // Contrôle anti-fuite : tout refusé, puis une fuite simulée sur /.env.
    expect(await ops.check("mytakumi")).toMatchObject({ ok: true, results: CHECK_PATHS.map((p) => ({ path: p, status: 403 })) });
    served = new Set(["/.env"]);
    expect(await ops.check("mytakumi")).toMatchObject({ ok: false, results: expect.arrayContaining([{ path: "/.env", status: 200 }]) });
    served = new Set();

    await ops.setEnabled("mytakumi", false);
    expect(m.nodes.has("/etc/nginx/kouziaphp-sites/mytakumi.conf.off")).toBe(true);
    expect(m.nodes.has("/etc/nginx/kouziaphp-sites/mytakumi.conf")).toBe(false);
    // Un réglage pendant la coupure ne rallume rien.
    await ops.upsert(spec);
    expect(m.nodes.has("/etc/nginx/kouziaphp-sites/mytakumi.conf")).toBe(false);
    await ops.setEnabled("mytakumi", true);
    expect(m.nodes.has("/etc/nginx/kouziaphp-sites/mytakumi.conf")).toBe(true);

    await ops.remove("mytakumi");
    expect([...m.nodes.keys()].some((k) => k.includes("mytakumi"))).toBe(false);
    expect(m.runs).toContain("/usr/sbin/deluser php-mytakumi");
    await expect(ops.publish("mytakumi", 1)).rejects.toThrow(/Site inconnu/);
  });

  it("archive piégée refusée avant toute extraction", async () => {
    const m = memorySys((file, args) =>
      file === "/bin/tar" && args[0] === "-tvzf" ? { code: 0, stdout: "lrwxrwxrwx 0/0 0 2026-10-25 10:00 x -> /etc/shadow\n", stderr: "" } : { code: 0, stdout: "", stderr: "" },
    );
    const ops = siteOperations({ ...ctx, paths, limitsEffective: () => false, sys: m.sys });
    await ops.upsert(spec);
    await expect(ops.receive("mytakumi", 1, "/srv/sites/mytakumi/incoming/a.tar.gz")).rejects.toThrow(/lien/);
    expect(m.runs.some((r) => r.startsWith("/bin/tar -x"))).toBe(false);
  });
});

describe("envoi d'une version à l'agent (flux, empreinte signée)", () => {
  const SECRET = "s".repeat(48);
  let server: Server;
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("archive reçue en flux et vérifiée ; empreinte différente : refusée, rien gardé", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kouzia-agent-"));
    const received: Array<{ slug: string; n: number; file: string }> = [];
    const probes = { now: () => Date.now() } as unknown as Probes;
    server = createAgent({
      secret: SECRET,
      allowedIps: ["127.0.0.1"],
      probes,
      sites: {
        incomingFile: async (_slug, nonce) => join(dir, `${nonce}.tar.gz`),
        receive: async (slug, n, file) => {
          received.push({ slug, n, file });
          return { slug, version: n };
        },
        upsert: async () => ({ slug: "x", uid: 1, created: true }),
        publish: async (slug, n) => ({ slug, current: n }),
        setEnabled: async (slug, enabled) => ({ slug, enabled }),
        check: async (slug) => ({ slug, ok: true, results: [] }),
        remove: async (slug) => ({ slug, removed: true }),
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const send = async (body: Buffer, declared: string, nonce: string) => {
      const ts = String(Math.floor(Date.now() / 1000));
      const path = "/v1/sites/mytakumi/versions/3";
      const signature = `sha256=${createHmac("sha256", SECRET).update(`${ts}.${nonce}.PUT.${path}.${declared}`).digest("hex")}`;
      return fetch(base + path, {
        method: "PUT",
        body,
        headers: { "x-kouzia-hub-timestamp": ts, "x-kouzia-hub-nonce": nonce, "x-kouzia-hub-signature": signature, "x-kouzia-hub-content-sha256": declared },
      });
    };
    const archive = Buffer.from("contenu de l'archive");
    const sha = createHash("sha256").update(archive).digest("hex");

    const ok = await send(archive, sha, "a".repeat(32));
    expect(ok.status).toBe(200);
    expect(received).toEqual([{ slug: "mytakumi", n: 3, file: join(dir, `${"a".repeat(32)}.tar.gz`) }]);

    const altered = await send(Buffer.from("autre contenu"), sha, "b".repeat(32));
    expect(altered.status).toBe(400);
    expect(existsSync(join(dir, `${"b".repeat(32)}.tar.gz`))).toBe(false);
    expect(received).toHaveLength(1);

    // Opération inconnue ou chemin piégé : jamais exécutés.
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await fetch(`${base}/v1/sites/..%2Fetc/versions/1`, { method: "PUT", body: archive, headers: { "x-kouzia-hub-timestamp": ts } });
    expect(res.status).toBe(401);
  });
});
