import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import yauzl from "yauzl";
import type { CachePurgeResult, ExportSummary, HubCachePurgeResult, SiteFilesPurgeResult, StorageUsage } from "@/contract.js";
import { withUploadSessionBusy } from "@/lib/uploads.js";
import { prisma, resetDb } from "../helpers/db.js";
import { buildTestHub, createPersoSite, settle, type MultipartFile, type TestHub, uploadFiles } from "../helpers/hub.js";

let hub: TestHub;
let siteId: string;

beforeEach(async () => {
  await resetDb();
  hub = await buildTestHub();
  hub.services.blobs.recentGraceMs = 0;
  siteId = await createPersoSite(hub, "alpha");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await hub.app.close();
});

async function upload(files: MultipartFile[]) {
  // Envoi par session, seul chemin d'entrée des fichiers.
  const res = await uploadFiles(hub, siteId, files);
  expect(res.statusCode, res.body).toBe(200);
}
async function publish() {
  await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/publish`, headers: hub.headers, payload: {} });
  await settle(hub);
}
const post = (url: string, payload?: object) => hub.app.inject({ method: "POST", url, headers: hub.headers, ...(payload ? { payload } : {}) });
const patch = (payload: object) => hub.app.inject({ method: "PATCH", url: `/api/sites/${siteId}`, headers: hub.headers, payload });
const summary = async (q = "") => (await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/export/summary${q}`, headers: hub.headers })).json() as ExportSummary;

function unzip(buffer: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out = new Map<string, string>();
      zip.on("entry", (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e);
          const parts: Buffer[] = [];
          stream.on("data", (c: Buffer) => parts.push(c));
          stream.on("end", () => {
            out.set(entry.fileName, Buffer.concat(parts).toString("utf8"));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(out));
      zip.readEntry();
    });
  });
}

describe("P2-1 : export Pages avec les en-têtes de sécurité", () => {
  it("_headers : bloc /* de sécurité (CSP, nosniff...), sans X-Robots-Tag ; HSTS seulement avec le domaine final", async () => {
    await upload([{ filename: "index.html", content: "<h1>x</h1>" }]);
    await publish();
    let files = await unzip((await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/export?target=pages`, headers: hub.headers })).rawPayload);
    let headers = files.get("_headers")!;
    for (const h of ["Content-Security-Policy: default-src 'self'", "X-Content-Type-Options: nosniff", "Referrer-Policy: strict-origin-when-cross-origin", "Permissions-Policy:", "Cross-Origin-Opener-Policy: same-origin", "X-Frame-Options: SAMEORIGIN"]) {
      expect(headers).toContain(h);
    }
    expect(headers).not.toContain("X-Robots-Tag");
    expect(headers).not.toContain("Strict-Transport-Security");
    await patch({ finalDomain: "client-exemple.fr" });
    files = await unzip((await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/export?target=pages`, headers: hub.headers })).rawPayload);
    headers = files.get("_headers")!;
    expect(headers).toContain("Strict-Transport-Security: max-age=31536000");
  });
});

describe("P2-3 : purge des fichiers sous le verrou du site", () => {
  it("refusée pendant une autre action sur le site", async () => {
    const release = await hub.services.engine.acquire(siteId);
    try {
      const res = await post(`/api/sites/${siteId}/files/purge`, { confirm: "alpha" });
      expect(res.statusCode).toBe(409);
    } finally {
      release();
    }
  });

  it("version servie relue à chaque version : jamais purgée, même si elle change en cours de route", async () => {
    for (let i = 1; i <= 3; i++) {
      await upload([{ filename: "index.html", content: `<h1>${i}</h1>` }]);
      await publish();
    }
    const v3 = await prisma.version.findFirstOrThrow({ where: { siteId, number: 3 } });
    const original = hub.cf.deleteDeployment.bind(hub.cf);
    let first = true;
    hub.cf.deleteDeployment = async (project, id) => {
      if (first) {
        first = false;
        await prisma.site.update({ where: { id: siteId }, data: { currentVersionId: v3.id } });
      }
      return original(project, id);
    };
    const body = (await post(`/api/sites/${siteId}/files/purge`, { confirm: "alpha", versions: true })).json() as SiteFilesPurgeResult;
    expect(body.versions?.purged).toEqual([2]);
    expect(body.versions?.kept).toEqual([3, 4]);
    expect((await prisma.version.findUniqueOrThrow({ where: { id: v3.id } })).status).toBe("PUBLISHED");
  });

  it("échec de la base après la suppression chez Cloudflare : version gardée, rapport partiel, audit en erreur", async () => {
    for (let i = 1; i <= 2; i++) {
      await upload([{ filename: "index.html", content: `<h1>${i}</h1>` }]);
      await publish();
    }
    // Seule la transaction de la purge d'une version (tableau de requêtes) échoue, une fois.
    const original = prisma.$transaction.bind(prisma) as (...a: unknown[]) => Promise<unknown>;
    let failedOnce = false;
    vi.spyOn(prisma, "$transaction").mockImplementation(((arg: unknown, ...rest: unknown[]) => {
      if (Array.isArray(arg) && !failedOnce) {
        failedOnce = true;
        return Promise.reject(new Error("base occupée"));
      }
      return original(arg, ...rest);
    }) as never);
    const body = (await post(`/api/sites/${siteId}/files/purge`, { confirm: "alpha", versions: true })).json() as SiteFilesPurgeResult;
    expect(body.versions).toEqual({ purged: [], kept: [2, 3], failed: [{ number: 2, error: expect.stringMatching(/relancez la purge/) }] });
    expect((await prisma.version.findFirstOrThrow({ where: { siteId, number: 2 } })).status).toBe("PUBLISHED");
    expect(await prisma.auditEvent.findFirst({ where: { action: "versions.purge" } })).toMatchObject({ result: "error" });
  });
});

describe("P2-4 : purge du cache, envois occupés gardés", () => {
  it("session en cours d'assemblage ou d'import : gardée et comptée à part", async () => {
    const dir = path.join(hub.services.dataDir, "uploads");
    for (const id of ["b".repeat(24), "c".repeat(24)]) {
      mkdirSync(path.join(dir, id), { recursive: true });
      writeFileSync(path.join(dir, id, "session.json"), JSON.stringify({ siteId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
    }
    let finish!: () => void;
    const busy = withUploadSessionBusy("b".repeat(24), () => new Promise<void>((r) => (finish = r)));
    const res = (await post("/api/storage/purge", { uploads: true, confirm: true })).json() as HubCachePurgeResult;
    expect(res.uploads?.count).toBe(1);
    expect(res.uploadsSkipped).toBe(1);
    finish();
    await busy;
  });
});

describe("P2-5 : fichiers de développement retirés de l'export", () => {
  it("notes, manifestes, configuration et fichiers cachés retirés ; .well-known et .htaccess gardés", async () => {
    await upload([
      { filename: "index.html", content: "<h1>x</h1>" },
      { filename: "README.md", content: "# notes" },
      { filename: "docs/guide.markdown", content: "x" },
      { filename: "package.json", content: "{}" },
      { filename: "package-lock.json", content: "{}" },
      { filename: "yarn.lock", content: "x" },
      { filename: "pnpm-lock.yaml", content: "x" },
      { filename: "tsconfig.app.json", content: "{}" },
      { filename: ".gitignore", content: "x" },
      { filename: ".npmrc", content: "x" },
      { filename: ".editorconfig", content: "x" },
      { filename: "assets/.cache-info", content: "x" },
      { filename: ".well-known/security.txt", content: "Contact: mailto:securite@exemple.fr" },
    ]);
    await publish();
    const s = await summary();
    const removed = s.issues.find((i) => i.code === "dev_files_removed")!;
    expect(removed.paths.sort()).toEqual(
      [".editorconfig", ".gitignore", ".npmrc", "README.md", "assets/.cache-info", "docs/guide.markdown", "package-lock.json", "package.json", "pnpm-lock.yaml", "tsconfig.app.json", "yarn.lock"].sort(),
    );
    const files = await unzip((await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/export`, headers: hub.headers })).rawPayload);
    expect(files.has(".well-known/security.txt")).toBe(true);
    expect(files.has(".htaccess")).toBe(true);
    expect([...files.keys()].some((k) => k.endsWith(".md") || k === "package.json")).toBe(false);
  });
});

describe("P2-6 : noms de la zone du hub protégés", () => {
  it("domaine final refusé : zone, www, hub, erp, api, ou adresse d'un autre site", async () => {
    await createPersoSite(hub, "voisin");
    for (const host of ["kouzia.com", "www.kouzia.com", "hub.kouzia.com", "erp.kouzia.com", "api.kouzia.com", "voisin.kouzia.com"]) {
      const res = await patch({ finalDomain: host });
      expect(res.statusCode, host).toBe(400);
      expect(res.json().code, host).toBe("final_domain_conflict");
    }
    expect((await patch({ finalDomain: "vitrine-alpha.kouzia.com" })).statusCode).toBe(200);
  });

  it("purge Cloudflare : un domaine final enregistré qui viserait le hub ou un autre site n'est jamais purgé", async () => {
    await createPersoSite(hub, "voisin");
    for (const host of ["kouzia.com", "hub.kouzia.com", "erp.kouzia.com", "api.kouzia.com", "voisin.kouzia.com"]) {
      // Valeur posée hors de l'API (ancienne donnée) : la purge doit quand même la refuser.
      await prisma.site.update({ where: { id: siteId }, data: { finalDomain: host, canonicalHost: "apex" } });
      hub.cf.purges.length = 0;
      const res = (await post(`/api/sites/${siteId}/cache/purge`)).json() as CachePurgeResult;
      expect(res.hosts, host).toEqual(["alpha.kouzia.com"]);
      expect(res.skippedHosts, host).toContain(host);
      expect(hub.cf.purges).toEqual([{ hosts: ["alpha.kouzia.com"] }]);
    }
    await prisma.site.update({ where: { id: siteId }, data: { finalDomain: "vitrine-alpha.kouzia.com", canonicalHost: "apex" } });
    const ok = (await post(`/api/sites/${siteId}/cache/purge`)).json() as CachePurgeResult;
    expect(ok.hosts).toEqual(["alpha.kouzia.com", "vitrine-alpha.kouzia.com", "www.vitrine-alpha.kouzia.com"]);
  });
});

describe("P2-7 : .htaccess généré sous un ancien profil", () => {
  it("remplacé par celui du profil actuel, sans écart « modifié à la main »", async () => {
    await upload([{ filename: "index.html", content: "<h1>x</h1>" }]);
    await upload([{ filename: ".htaccess", content: "# Généré par le hub Kouzia. Modifiable : ancien profil\nErrorDocument 404 /ancien.html\n" }]);
    await publish();
    await patch({ finalDomain: "client-exemple.fr" });
    const s = await summary();
    expect(s.issues.map((i) => i.code)).not.toContain("htaccess_modified");
    const files = await unzip((await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/export`, headers: hub.headers })).rawPayload);
    expect(files.get(".htaccess")).toContain("https://www.client-exemple.fr");
    expect(files.get(".htaccess")).not.toContain("/ancien.html");
  });
});

describe("P2-8 : place utilisée en cache 10 s, vidé à chaque purge", () => {
  it("relue depuis le cache, puis recalculée après une purge", async () => {
    await upload([{ filename: "index.html", content: "A".repeat(500) }]);
    const first = (await hub.app.inject({ method: "GET", url: "/api/storage", headers: hub.headers })).json() as StorageUsage;
    await upload([{ filename: "autre.txt", content: "B".repeat(700) }]);
    const cached = (await hub.app.inject({ method: "GET", url: "/api/storage", headers: hub.headers })).json() as StorageUsage;
    expect(cached).toEqual(first);
    await post("/api/storage/purge", { temp: true });
    const fresh = (await hub.app.inject({ method: "GET", url: "/api/storage", headers: hub.headers })).json() as StorageUsage;
    expect(fresh.sites.find((s) => s.siteId === siteId)!.workingBytes).toBe(first.sites.find((s) => s.siteId === siteId)!.workingBytes + 700);
  });
});
