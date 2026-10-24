import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FilesResponse, Operation, SiteDetail, UploadResult } from "@/contract.js";
import { PhpAgentClient } from "@/lib/php-agent/client.js";
import { createAgent, type Probes } from "../../../../../scripts/php-ct/agent/agent.mjs";
import { siteOperations, type Paths } from "../../../../../scripts/php-ct/agent/sites.mjs";
import { prisma, resetDb } from "../helpers/db.js";
import { buildTestHub, settle, uploadFiles, type TestHub } from "../helpers/hub.js";
import { memorySys } from "../helpers/php-memory.js";

// Site PHP de bout en bout (docs/cadrage.md, section 11, lot P3) : le vrai hub, le vrai agent (serveur et client
// signés), ses opérations sur un système de fichiers en mémoire. Aucune commande système, aucun root.
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

let hub: TestHub;
let server: Server;
let mem: ReturnType<typeof memorySys>;
let leaks: Set<string>;
const incoming = mkdtempSync(join(tmpdir(), "kouzia-php-in-"));

beforeEach(async () => {
  await resetDb();
  leaks = new Set();
  // tar simulé : la liste annonce un fichier ordinaire, l'extraction ne fait rien (mémoire).
  mem = memorySys((file, args) =>
    file === "/bin/tar" && args[0] === "-tvzf" ? { code: 0, stdout: "-rw-r--r-- 0/0 1 2026-10-25 10:00 public/index.html\n", stderr: "" } : { code: 0, stdout: "", stderr: "" },
  );
  const ops = siteOperations({
    paths,
    domain: "kouzia.com",
    phpInstalled: () => ["8.3"],
    limitsEffective: () => true,
    httpStatus: async (_host, p) => (leaks.has(p) ? 200 : 404),
    sys: mem.sys,
  });
  const probes = {
    alpine: () => "3.22.2",
    php: () => ["8.3"],
    service: async () => "running",
    cgroups: () => ({ result: "ok", checkedAt: null }),
    lastUpgrade: () => "2026-10-25",
    disk: () => null,
    sites: () => 0,
    tunnelId: () => TUNNEL,
    now: () => Date.now(),
  } satisfies Probes;
  // L'archive reçue est écrite sur le vrai disque (flux), puis traitée par les opérations en mémoire.
  server = createAgent({ secret: SECRET, allowedIps: ["127.0.0.1"], probes, sites: { ...ops, incomingFile: async (slug, nonce) => (await ops.incomingFile(slug, nonce), join(incoming, `${nonce}.tar.gz`)) } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const agent = new PhpAgentClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, secret: SECRET });
  hub = await buildTestHub({ phpAgent: agent });
});
afterEach(async () => {
  await hub.app.close();
  await new Promise((resolve) => server.close(resolve));
});

const create = (over: Record<string, unknown> = {}) =>
  hub.app.inject({ method: "POST", url: "/api/sites", headers: hub.headers, payload: { kind: "PERSO", slug: "mytakumi", label: "MyTakumi", hosting: "php", php: { persistentDirs: ["data"] }, ...over } });
const detail = async (id: string) => (await hub.app.inject({ method: "GET", url: `/api/sites/${id}`, headers: hub.headers })).json() as SiteDetail;
const post = (id: string, action: string, payload: Record<string, unknown> = {}) =>
  hub.app.inject({ method: "POST", url: `/api/sites/${id}/${action}`, headers: hub.headers, payload });

describe("site PHP de bout en bout", () => {
  it("création : posé sur le CT, page d'attente dans public/, CNAME vers le tunnel, en ligne sans attente de certificat", async () => {
    const res = await create();
    expect(res.statusCode).toBe(201);
    const id = (res.json() as SiteDetail).id;
    await settle(hub);
    const site = await detail(id);
    expect(site).toMatchObject({ hosting: "php", state: "ONLINE", pagesProject: null, php: { version: "8.3", publicDir: "public", persistentDirs: ["data"], httpsOpen: true, imapOpen: false } });
    expect(site.currentVersion?.number).toBe(1);
    const record = await hub.cf.findDnsRecord("mytakumi.kouzia.com");
    expect(record).toMatchObject({ type: "CNAME", content: `${TUNNEL}.cfargotunnel.com` });
    expect(mem.nodes.get("/srv/sites/mytakumi/current")).toEqual({ type: "link", target: "releases/1" });
    expect((await prisma.version.findFirstOrThrow({ where: { siteId: id, number: 1 }, include: { files: true } })).files.map((f) => f.path)).toEqual(["public/index.html"]);
    // Contrôle des orphelins : le CNAME vers le tunnel est reconnu, aucun projet Pages attendu.
    const orphans = (await hub.app.inject({ method: "POST", url: "/api/orphans/check", headers: hub.headers })).json() as { findings: Array<{ name: string }> };
    expect(orphans.findings.filter((f) => f.name.includes("mytakumi"))).toEqual([]);
    // CNAME détourné vers une autre cible : signalé.
    await hub.cf.updateCname(record!.id, "mytakumi.kouzia.com", "autre.example.com", record!.comment ?? "");
    const after = (await hub.app.inject({ method: "POST", url: "/api/orphans/check", headers: hub.headers })).json() as { findings: Array<{ name: string; type: string }> };
    expect(after.findings).toEqual(expect.arrayContaining([expect.objectContaining({ type: "dns", name: "mytakumi.kouzia.com" })]));
    // Aucun appel Cloudflare Pages pour ce site.
    expect((await hub.cf.listProjects()).map((p) => p.name)).not.toContain("kz-mytakumi");
  });

  it("envoi : src/ et composer.json gardés pour un site PHP, .env et README toujours refusés ; publication puis retour arrière", async () => {
    const id = ((await create()).json() as SiteDetail).id;
    await settle(hub);
    // Onglet Fichiers : règle du site PHP (page d'entrée dans public/), jamais « index.html à la racine ».
    const filesOf = async () => (await hub.app.inject({ method: "GET", url: `/api/sites/${id}/files`, headers: hub.headers })).json() as FilesResponse;
    const before = await filesOf();
    expect(before.hasIndex).toBe(false);
    expect(before.versionCheck?.message).toContain("Ni index.php ni index.html dans le dossier public « public/ »");
    const sent = await uploadFiles(hub, id, [
      { filename: "public/index.php", content: "<?php require '../src/App.php';" },
      { filename: "src/App.php", content: "<?php class App {}" },
      { filename: "composer.json", content: "{}" },
      { filename: ".env", content: "DB_PASSWORD=x" },
      { filename: "README.md", content: "# notes" },
    ]);
    const body = sent.json() as UploadResult;
    expect(body.accepted.sort()).toEqual(["composer.json", "public/index.php", "src/App.php"]);
    expect(body.rejected.map((r) => r.path).sort()).toEqual([".env", "README.md"]);
    expect(body.serverApp).toBeNull();
    const after = await filesOf();
    expect([after.hasIndex, after.versionCheck]).toEqual([true, null]);

    expect((await post(id, "publish")).statusCode).toBeLessThan(300);
    await settle(hub);
    expect((await detail(id)).currentVersion?.number).toBe(2);
    expect(mem.nodes.get("/srv/sites/mytakumi/current")).toEqual({ type: "link", target: "releases/2" });

    // Version 3, puis retour arrière : republier la version 2 crée la version 4 (mêmes fichiers), servie.
    // (La version 1, page d'attente, est purgée dès la première vraie publication, comme pour Pages.)
    await uploadFiles(hub, id, [{ filename: "public/index.php", content: "<?php echo 3;" }]);
    await post(id, "publish");
    await settle(hub);
    expect((await detail(id)).currentVersion?.number).toBe(3);
    const v2 = await prisma.version.findFirstOrThrow({ where: { siteId: id, number: 2 }, include: { files: true } });
    const republish = await post(id, `versions/${v2.id}/publish`);
    expect(republish.statusCode, republish.body).toBeLessThan(300);
    await settle(hub);
    const v4 = await prisma.version.findFirstOrThrow({ where: { siteId: id, number: 4 }, include: { files: true } });
    expect(v4.files.map((f) => [f.path, f.sha256]).sort()).toEqual(v2.files.map((f) => [f.path, f.sha256]).sort());
    expect((await detail(id)).currentVersion?.number).toBe(4);
    expect(mem.nodes.get("/srv/sites/mytakumi/current")).toEqual({ type: "link", target: "releases/4" });
  });

  it("fuite après publication : site coupé, publication en échec avec les chemins en cause", async () => {
    const id = ((await create()).json() as SiteDetail).id;
    await settle(hub);
    await uploadFiles(hub, id, [{ filename: "public/index.php", content: "<?php echo 1;" }]);
    leaks = new Set(["/.env"]);
    await post(id, "publish");
    await settle(hub);
    const op = (await detail(id)).operation as Operation;
    expect(op).toMatchObject({ kind: "PUBLISH", status: "FAILED" });
    expect(op.error).toMatch(/Fuite détectée.*\/\.env \(200\)/);
    expect(mem.nodes.has("/etc/nginx/kouziaphp-sites/mytakumi.conf.off")).toBe(true);
  });

  it("coupure, rallumage, suppression : CNAME retiré puis reposé, site retiré du CT", async () => {
    const id = ((await create()).json() as SiteDetail).id;
    await settle(hub);
    await post(id, "disable");
    await settle(hub);
    expect(await hub.cf.findDnsRecord("mytakumi.kouzia.com")).toBeNull();
    expect((await detail(id)).state).toBe("OFFLINE");
    expect(mem.nodes.has("/etc/nginx/kouziaphp-sites/mytakumi.conf.off")).toBe(true);
    await post(id, "enable");
    await settle(hub);
    expect((await detail(id)).state).toBe("ONLINE");
    expect(await hub.cf.findDnsRecord("mytakumi.kouzia.com")).not.toBeNull();
    const del = await hub.app.inject({ method: "DELETE", url: `/api/sites/${id}`, headers: hub.headers, payload: { confirm: "mytakumi" } });
    expect(del.statusCode).toBeLessThan(300);
    await settle(hub);
    expect(await prisma.site.findUnique({ where: { id } })).toBeNull();
    expect([...mem.nodes.keys()].some((k) => k.includes("mytakumi"))).toBe(false);
    expect(await hub.cf.findDnsRecord("mytakumi.kouzia.com")).toBeNull();
  });

  it("refus avant tout écrit : réglages douteux (400) ; sans agent (503)", async () => {
    const bad = await create({ php: { publicDir: "../etc" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "php_settings" });
    expect((await create({ php: { version: "7.4" } })).json()).toMatchObject({ code: "php_settings" });
    expect(await prisma.site.count()).toBe(0);
    await hub.app.close();
    hub = await buildTestHub();
    const none = await create();
    expect(none.statusCode).toBe(503);
    expect(none.json()).toMatchObject({ code: "php_unavailable" });
    expect(await prisma.site.count()).toBe(0);
  });
});
