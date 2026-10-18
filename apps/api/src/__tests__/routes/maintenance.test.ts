import { mkdirSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import yauzl from "yauzl";
import type { CachePurgeResult, ExportSummary, HubCachePurgeResult, SiteDetail, SiteFilesPurgeResult, StorageUsage, VersionEntry } from "@/contract.js";
import { CloudflareError } from "@/lib/cloudflare/types.js";
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
  await hub.app.close();
});

async function upload(files: MultipartFile[]) {
  // Envoi par session, seul chemin d'entrée des fichiers.
  const res = await uploadFiles(hub, siteId, files);
  expect(res.statusCode, res.body).toBe(200);
}
async function publish() {
  const res = await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/publish`, headers: hub.headers, payload: {} });
  expect(res.statusCode, res.body).toBe(200);
  await settle(hub);
}
const post = (url: string, payload?: object) => hub.app.inject({ method: "POST", url, headers: hub.headers, ...(payload ? { payload } : {}) });
const get = async <T>(url: string) => {
  const res = await hub.app.inject({ method: "GET", url, headers: hub.headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as T;
};
const versions = () => get<VersionEntry[]>(`/api/sites/${siteId}/versions`);

describe("purge des fichiers d'un site", () => {
  it("confirmation exacte exigée", async () => {
    expect((await post(`/api/sites/${siteId}/files/purge`, { confirm: "ALPHA" })).statusCode).toBe(400);
    expect((await post(`/api/sites/${siteId}/files/purge`, {})).statusCode).toBe(400);
  });

  it("vide la version de travail ; versions gardées et republiables ; .htaccess « missing », non régénéré", async () => {
    await upload([{ filename: "index.html", content: "<h1>v1</h1>" }, { filename: "unique.txt", content: "seulement-dans-le-travail" }]);
    await publish();
    await upload([{ filename: "brouillon.txt", content: "jamais-publie" }]);
    const res = await post(`/api/sites/${siteId}/files/purge`, { confirm: "alpha" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SiteFilesPurgeResult;
    expect(body).toMatchObject({ removedFiles: 4, versions: null, files: { files: [], workingDirty: false } });
    // Seul « brouillon.txt » n'était référencé nulle part ailleurs (le reste est dans la version publiée).
    expect(body.freedBytes).toBe("jamais-publie".length);
    const site = await get<SiteDetail>(`/api/sites/${siteId}`);
    expect(site.serverConfig.status).toBe("missing");
    const [v] = await versions();
    expect(v).toMatchObject({ status: "PUBLISHED", current: true });
    const republish = await post(`/api/sites/${siteId}/versions/${v!.id}/publish`);
    expect(republish.statusCode).toBe(200);
    await settle(hub);
    expect((await versions())[0]).toMatchObject({ source: "republish", status: "PUBLISHED" });
    expect(await prisma.auditEvent.findFirst({ where: { action: "files.purge" } })).toMatchObject({ result: "ok", siteSlug: "alpha" });
  });

  it("anciennes versions : déploiements supprimés, la servie toujours gardée, échec Cloudflare partiel rapporté", async () => {
    for (let i = 1; i <= 3; i++) {
      await upload([{ filename: "index.html", content: `<h1>${i}</h1>` }]);
      await publish();
    }
    const before = await versions();
    expect(before.map((v) => `${v.number}:${v.status}`)).toEqual(["4:PUBLISHED", "3:PUBLISHED", "2:PUBLISHED", "1:PURGED"]);
    hub.cf.failNext("deleteDeployment");
    const body = (await post(`/api/sites/${siteId}/files/purge`, { confirm: "alpha", versions: true })).json() as SiteFilesPurgeResult;
    expect(body.versions).toEqual({ purged: [3], kept: [2, 4], failed: [{ number: 2, error: expect.any(String) }] });
    const after = await versions();
    expect(after.map((v) => `${v.number}:${v.status}`)).toEqual(["4:PUBLISHED", "3:PURGED", "2:PUBLISHED", "1:PURGED"]);
    expect(after[0]!.current).toBe(true);
    expect(await prisma.versionFile.count({ where: { version: { number: 3 } } })).toBe(0);
    expect(await prisma.versionFile.count({ where: { version: { number: 2 } } })).toBe(2);
    expect(await prisma.auditEvent.findFirst({ where: { action: "versions.purge" } })).toMatchObject({ result: "error" });
    // Reprise : la version restante est purgée, la servie reste.
    const again = (await post(`/api/sites/${siteId}/files/purge`, { confirm: "alpha", versions: true })).json() as SiteFilesPurgeResult;
    expect(again.versions).toEqual({ purged: [2], kept: [4], failed: [] });
    expect(hub.cf.deployments("kz-alpha")).toHaveLength(1);
  });
});

describe("cache du hub et place utilisée", () => {
  it("place utilisée par site (versions comptées une fois) et purge avec place libérée exacte", async () => {
    await upload([{ filename: "index.html", content: "A".repeat(1000) }]);
    await publish();
    await upload([{ filename: "index.html", content: "B".repeat(300) }]);
    const data = hub.services.dataDir;
    // Envoi en cours (non expiré), temporaire ancien, vignette capturée, blob orphelin.
    mkdirSync(path.join(data, "uploads", "a".repeat(24), "chunks"), { recursive: true });
    writeFileSync(path.join(data, "uploads", "a".repeat(24), "session.json"), JSON.stringify({ siteId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
    writeFileSync(path.join(data, "uploads", "a".repeat(24), "chunks", "0"), Buffer.alloc(5000));
    mkdirSync(path.join(data, "tmp"), { recursive: true });
    const tmp = path.join(data, "tmp", "vieux.zip");
    writeFileSync(tmp, Buffer.alloc(700));
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(tmp, old, old);
    await hub.services.thumbnails.save(siteId, Buffer.alloc(400), "capture");
    const orphan = await hub.services.blobs.putBuffer(Buffer.from("orphelin-du-test"));

    const usage = await get<StorageUsage>("/api/storage");
    const mine = usage.sites.find((s) => s.siteId === siteId)!;
    expect(mine.workingBytes).toBeGreaterThanOrEqual(300);
    // Version servie : index « A » (1000) + .htaccess identique à celui du travail (compté une fois, dans le travail).
    expect(mine.versionsBytes).toBe(1000);
    expect(mine.thumbnailBytes).toBe(400);
    // Morceau de 5 000 octets plus le descriptif de la session.
    expect(mine.uploadsBytes).toBeGreaterThan(5000);
    expect(mine.totalBytes).toBe(mine.workingBytes + mine.versionsBytes + 400 + mine.uploadsBytes);
    // Orphelins : le blob du test et la page d'attente de la création (version purgée par la rétention).
    expect(usage.total.orphanBytes).toBeGreaterThanOrEqual(orphan.size);
    const orphanBytes = usage.total.orphanBytes;

    const unconfirmed = await post("/api/storage/purge", { uploads: true, temp: true, thumbnails: true, orphans: true });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().code).toBe("confirm_required");
    const res = (await post("/api/storage/purge", { uploads: true, temp: true, thumbnails: true, orphans: true, confirm: true })).json() as HubCachePurgeResult;
    expect(res.uploads).toEqual({ count: 1, bytes: mine.uploadsBytes });
    expect(res.temp).toEqual({ count: 1, bytes: 700 });
    expect(res.thumbnails).toEqual({ count: 1, bytes: 400 });
    expect(res.orphans).toEqual({ count: expect.any(Number), bytes: orphanBytes });
    expect(res.freedBytes).toBe(mine.uploadsBytes + 700 + 400 + orphanBytes);
    expect((await get<StorageUsage>("/api/storage")).total.orphanBytes).toBe(0);
    expect(existsSync(hub.services.blobs.pathOf(orphan.sha256))).toBe(false);
    expect((await get<SiteDetail>(`/api/sites/${siteId}`)).thumbnailUrl).toBeNull();
    expect(await prisma.auditEvent.findFirst({ where: { action: "cache.purge" } })).toMatchObject({ result: "ok" });
  });

  it("une vignette envoyée à la main n'est jamais purgée ; purge limitée à un site", async () => {
    await hub.services.thumbnails.save(siteId, Buffer.alloc(100), "upload");
    const res = (await post("/api/storage/purge", { siteId, thumbnails: true, temp: true, confirm: true })).json() as HubCachePurgeResult;
    expect(res).toMatchObject({ thumbnails: { count: 0, bytes: 0 }, temp: null });
    expect((await get<SiteDetail>(`/api/sites/${siteId}`)).thumbnailSource).toBe("upload");
  });
});

describe("cache Cloudflare", () => {
  it("purge par nom d'hôte (domaine final hors zone non purgé)", async () => {
    await hub.app.inject({ method: "PATCH", url: `/api/sites/${siteId}`, headers: hub.headers, payload: { finalDomain: "client-exemple.fr" } });
    const res = (await post(`/api/sites/${siteId}/cache/purge`)).json() as CachePurgeResult;
    expect(res).toMatchObject({ method: "hosts", hosts: ["alpha.kouzia.com"], skippedHosts: ["www.client-exemple.fr", "client-exemple.fr"], complete: true });
    expect(hub.cf.purges).toEqual([{ hosts: ["alpha.kouzia.com"] }]);
  });

  it("repli par adresses en lots de 100 si la purge par nom d'hôte est refusée", async () => {
    const files = Array.from({ length: 149 }, (_, i) => ({ filename: `p/${i}.html`, content: `${i}` }));
    await upload([{ filename: "index.html", content: "x" }, ...files]);
    await publish();
    hub.cf.failNext("purgeCache", new CloudflareError("refus", 400, 1092));
    const res = (await post(`/api/sites/${siteId}/cache/purge`)).json() as CachePurgeResult;
    // 151 fichiers (index, .htaccess, 149 pages) + « / » pour l'index = 152 adresses : 2 lots.
    expect(res).toMatchObject({ method: "files", urlsTotal: 152, urlsPurged: 152, complete: true });
    const batches = hub.cf.purges.filter((p) => "files" in p) as Array<{ files: string[] }>;
    expect(batches.map((b) => b.files.length)).toEqual([100, 52]);
    expect(batches[0]!.files).toContain("https://alpha.kouzia.com/");

  });

  it("limite de débit dès le repli : rapport partiel ; sans le droit : message clair", async () => {
    await upload([{ filename: "index.html", content: "x" }]);
    await publish();
    hub.cf.failNext("purgeCache", new CloudflareError("refus", 400, 1092));
    hub.cf.failNext("purgeCache", new CloudflareError("limite", 429, 1134));
    const res = (await post(`/api/sites/${siteId}/cache/purge`)).json() as CachePurgeResult;
    expect(res).toMatchObject({ method: "files", urlsPurged: 0, complete: false, message: expect.stringMatching(/relancez dans une minute/) });

    hub.cf.failNext("purgeCache", new CloudflareError("Le jeton API n'a pas le droit de purger le cache : ajoutez la permission Cache Purge au jeton (hubctl secrets api).", 403));
    const denied = await post(`/api/sites/${siteId}/cache/purge`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "cf_permission", error: expect.stringMatching(/hubctl secrets api/) });
  });
});

// --- Export de production ---

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

const page = (title: string, extra = "", canonical = "https://www.client-exemple.fr/") =>
  `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="Description de ${title}"><link rel="canonical" href="${canonical}">${extra}</head><body><h1>${title}</h1></body></html>`;

async function exportZip(query = "") {
  const res = await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/export${query}`, headers: hub.headers });
  expect(res.statusCode, res.body).toBe(200);
  return { res, files: await unzip(res.rawPayload) };
}
const summary = (query = "") => get<ExportSummary>(`/api/sites/${siteId}/export/summary${query}`);
const codes = (s: ExportSummary) => s.issues.map((i) => i.code).sort();

describe("export de production", () => {
  it("rien de publié : 409", async () => {
    expect((await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/export/summary`, headers: hub.headers })).statusCode).toBe(409);
  });

  it("zip Hostinger : .htaccess du domaine final, 404, robots et sitemap générés, LISEZMOI ; ni noindex, ni _worker.js, ni fichier de dev", async () => {
    await hub.app.inject({ method: "PATCH", url: `/api/sites/${siteId}`, headers: hub.headers, payload: { finalDomain: "client-exemple.fr", canonicalHost: "www" } });
    await upload([
      { filename: "index.html", content: page("Accueil") },
      { filename: "contact/index.html", content: page("Contact", "", "https://www.client-exemple.fr/contact/") },
      { filename: "brouillon.html", content: page("Brouillon", '<meta name="robots" content="noindex, follow">') },
      { filename: "google1234abcd.html", content: "google-site-verification: google1234abcd.html" },
      { filename: "_headers", content: "/*\n  X-Test: 1\n" },
      { filename: "_redirects", content: "/ancien /nouveau 301\n" },
    ]);
    // Fichiers de dev glissés dans la version (hors envoi normal) : ils ne doivent jamais sortir.
    await publish();
    const version = await prisma.version.findFirstOrThrow({ where: { siteId, status: "PUBLISHED", source: "files" } });
    const blob = await hub.services.blobs.putBuffer(Buffer.from("SECRET=1"));
    await prisma.versionFile.createMany({
      data: [
        { versionId: version.id, path: ".env", sha256: blob.sha256, size: blob.size },
        { versionId: version.id, path: "_worker.js", sha256: blob.sha256, size: blob.size },
        { versionId: version.id, path: "_routes.json", sha256: blob.sha256, size: blob.size },
        { versionId: version.id, path: "app.js.map", sha256: blob.sha256, size: blob.size },
      ],
    });

    const s = await summary();
    expect(s).toMatchObject({ target: "hostinger", fileName: `alpha-v${version.number}-production.zip`, finalDomain: "client-exemple.fr", canonicalOrigin: "https://www.client-exemple.fr" });
    expect(s.generated).toEqual([".htaccess", "404.html", "LISEZMOI.txt", "robots.txt", "sitemap.xml"]);
    expect(codes(s)).toEqual(["dev_files_removed", "no_404", "noindex_meta", "pages_files_removed", "robots_generated", "sitemap_generated"]);
    expect(s.issues.find((i) => i.code === "noindex_meta")!.paths).toEqual(["brouillon.html"]);
    expect(s.removed.map((r) => r.path).sort()).toEqual([".env", "_headers", "_redirects", "_routes.json", "_worker.js", "app.js.map"]);

    const { res, files } = await exportZip();
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="alpha-v${version.number}-production.zip"`);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect([...files.keys()].sort()).toEqual([".htaccess", "404.html", "LISEZMOI.txt", "brouillon.html", "contact/index.html", "google1234abcd.html", "index.html", "robots.txt", "sitemap.xml"]);
    const htaccess = files.get(".htaccess")!;
    expect(htaccess).toContain("RewriteRule ^ https://www.client-exemple.fr%{REQUEST_URI} [R=301,L,NE]");
    expect(htaccess).toContain("ErrorDocument 404 /404.html");
    expect(htaccess).not.toMatch(/X-Robots-Tag "noindex/);
    expect(htaccess).not.toContain("kouzia.com");
    expect(files.get("robots.txt")).toBe("User-agent: *\nAllow: /\n\nSitemap: https://www.client-exemple.fr/sitemap.xml\n");
    for (const content of files.values()) expect(content).not.toMatch(/Disallow:\s*\/\s*$/m);
    const sitemap = files.get("sitemap.xml")!;
    expect([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])).toEqual(["https://www.client-exemple.fr/contact/", "https://www.client-exemple.fr/"]);
    expect(sitemap).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}T/);
    expect(files.get("404.html")).toContain("Page introuvable");
    expect(files.get("LISEZMOI.txt")).toContain("public_html");
    for (const content of files.values()) expect(content).not.toMatch(/[\u2013\u2014]/);
    expect(await prisma.auditEvent.findFirst({ where: { action: "version.export" } })).toMatchObject({ result: "ok", siteSlug: "alpha" });
  });

  it("target=pages : _headers et _redirects générés et fusionnés, pas de .htaccess, 404.html présente", async () => {
    await hub.app.inject({ method: "PATCH", url: `/api/sites/${siteId}`, headers: hub.headers, payload: { finalDomain: "client-exemple.fr", notFoundPage: "/erreur.html" } });
    await upload([
      { filename: "index.html", content: page("Accueil") },
      { filename: "erreur.html", content: page("Erreur", '<meta name="robots" content="noindex">') },
      { filename: "_headers", content: "/*\n  X-Test: 1\n" },
    ]);
    await publish();
    const { files } = await exportZip("?target=pages");
    expect(files.has(".htaccess")).toBe(false);
    expect(files.get("_headers")).toContain("X-Test: 1");
    expect(files.get("_headers")).toContain("/assets/*");
    expect(files.get("404.html")).toBe(files.get("erreur.html"));
    expect(files.has("_worker.js")).toBe(false);
    const s = await summary("?target=pages");
    expect(s.fileName).toMatch(/-production-pages\.zip$/);
    expect(codes(s)).not.toContain("no_404");
  });

  it("apex, robots fourni bloquant et Sitemap vers un autre domaine, .htaccess modifié à la main", async () => {
    await hub.app.inject({ method: "PATCH", url: `/api/sites/${siteId}`, headers: hub.headers, payload: { finalDomain: "client-exemple.fr", canonicalHost: "apex" } });
    await upload([
      { filename: "index.html", content: page("Accueil", "", "https://client-exemple.fr/") },
      { filename: "404.html", content: page("404") },
      { filename: "robots.txt", content: "User-agent: *\nDisallow: /\n\nSitemap: https://autre-site.fr/sitemap.xml\n" },
      { filename: ".htaccess", content: "# réglage maison\n" },
    ]);
    await publish();
    const s = await summary();
    expect(s.canonicalOrigin).toBe("https://client-exemple.fr");
    expect(codes(s)).toEqual(["htaccess_modified", "robots_blocking", "robots_sitemap_domain", "sitemap_generated"]);
    expect(s.issues.find((i) => i.code === "robots_blocking")!.level).toBe("error");
    const { files } = await exportZip();
    expect(files.get(".htaccess")).toBe("# réglage maison\n");
    expect(files.get("robots.txt")).toContain("Disallow: /");
    expect(files.get("sitemap.xml")).toContain("<loc>https://client-exemple.fr/</loc>");
  });

  it("sans domaine final : avertissement, pas de sitemap, robots sans ligne Sitemap, canonical non jugée", async () => {
    await upload([{ filename: "index.html", content: "<html><body>sans balises</body></html>" }]);
    await publish();
    const s = await summary();
    expect(s.issues.find((i) => i.code === "no_final_domain")!.message).toBe("Renseignez le domaine final (onglet Serveur) pour le sitemap et la forme canonique.");
    expect(codes(s)).toEqual(["canonical_missing", "description_missing", "no_404", "no_final_domain", "robots_generated", "title_missing"]);
    const { files } = await exportZip();
    expect(files.has("sitemap.xml")).toBe(false);
    expect(files.get("robots.txt")).toBe("User-agent: *\nAllow: /\n");
    expect(files.get(".htaccess")).toContain("Domaine final pas encore renseigné");
  });

  it("cas d'une sortie d'Astro : sitemap-index et enfant gardés, pages en dossier, 404, fichiers hachés", async () => {
    await hub.app.inject({ method: "PATCH", url: `/api/sites/${siteId}`, headers: hub.headers, payload: { finalDomain: "vitrine-exemple.fr", canonicalHost: "apex" } });
    const origin = "https://vitrine-exemple.fr";
    await upload([
      { filename: "index.html", content: page("Accueil", '<meta name="robots" content="index,follow">', `${origin}/`) },
      { filename: "fr/index.html", content: page("Accueil FR", "", `${origin}/fr/`) },
      { filename: "mentions-legales/index.html", content: page("Mentions", "", `${origin}/mentions-legales/`) },
      { filename: "404.html", content: page("404", '<meta name="robots" content="noindex,follow">') },
      { filename: "_astro/index.Bx3k9aZq.css", content: "body{}" },
      { filename: "_astro/photo.CGlva6MA_17fAee.webp", content: "RIFF" },
      { filename: "robots.txt", content: `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap-index.xml\n` },
      {
        filename: "sitemap-index.xml",
        content: `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${origin}/sitemap-0.xml</loc></sitemap><sitemap><loc>${origin}/sitemap-1.xml</loc></sitemap></sitemapindex>`,
      },
      {
        filename: "sitemap-0.xml",
        content: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url><url><loc>${origin}/fr/</loc></url><url><loc>https://www.vitrine-exemple.fr/mentions-legales/</loc></url></urlset>`,
      },
    ]);
    await publish();
    const s = await summary();
    expect(codes(s)).toEqual(["sitemap_child_missing", "sitemap_domain"]);
    expect(s.issues.find((i) => i.code === "sitemap_domain")!.paths).toEqual(["https://www.vitrine-exemple.fr/mentions-legales/"]);
    expect(s.issues.find((i) => i.code === "sitemap_child_missing")!.paths).toEqual(["sitemap-1.xml"]);
    expect(s.generated).toEqual([".htaccess", "LISEZMOI.txt"]);
    const { files } = await exportZip();
    expect(files.get("sitemap-index.xml")).toContain("sitemap-0.xml");
    expect(files.has("sitemap.xml")).toBe(false);
    expect(files.get("robots.txt")).toContain("sitemap-index.xml");
    expect(files.has("_astro/index.Bx3k9aZq.css")).toBe(true);
    expect(files.get(".htaccess")).toContain("RewriteRule ^ https://vitrine-exemple.fr%{REQUEST_URI} [R=301,L,NE]");
  });
});
