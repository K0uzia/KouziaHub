import { afterEach, beforeEach, describe, expect, it } from "vitest";
import yauzl from "yauzl";
import type { ServerConfigPreview, SiteDetail, UploadResult } from "@/contract.js";
import { buildHtaccess, GENERATED_MARKER } from "@/lib/server-config.js";
import { prisma, resetDb } from "../helpers/db.js";
import { buildTestHub, createPersoSite, makeZip, settle, uploadFiles, uploadZip, type TestHub } from "../helpers/hub.js";

let hub: TestHub;
let siteId: string;

beforeEach(async () => {
  await resetDb();
  hub = await buildTestHub();
  siteId = await createPersoSite(hub, "alpha");
});
afterEach(async () => {
  await hub.app.close();
});

const detail = async () => (await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}`, headers: hub.headers })).json() as SiteDetail;
const htaccess = async () => {
  const res = await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/files/raw?path=.htaccess`, headers: hub.headers });
  return res.statusCode === 200 ? res.body : null;
};
const patch = (payload: Record<string, unknown>) => hub.app.inject({ method: "PATCH", url: `/api/sites/${siteId}`, headers: hub.headers, payload });
const regenerate = (force?: boolean) =>
  hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/server-config/regenerate`, headers: hub.headers, payload: force === undefined ? {} : { force } });
const upload = (filename: string, content: string) => uploadFiles(hub, siteId, [{ filename, content }]);
const audits = async (action: string) => prisma.auditEvent.count({ where: { action, siteId } });

describe("profil et .htaccess généré", () => {
  it("la création écrit le .htaccess dans la version de travail, profil par défaut", async () => {
    const site = await detail();
    expect(site).toMatchObject({ finalDomain: null, canonicalHost: "www", notFoundPage: "/404.html" });
    expect(site.serverConfig).toMatchObject({ status: "generated", path: ".htaccess", notFoundPagePresent: false });
    expect(site.serverConfig.generatedAt).not.toBeNull();
    const content = await htaccess();
    expect(content!.startsWith(GENERATED_MARKER)).toBe(true);
    expect(content).toBe(buildHtaccess({ finalDomain: null, canonicalHost: "www", notFoundPage: "/404.html" }, { hashedDirs: [], notFoundPresent: false, sitemaps: [] }));
    // Un .htaccess seul ne rend pas le site « modifié » (rien à publier sans index.html).
    expect(site.workingDirty).toBe(false);
    expect(await audits("server-config.generate")).toBe(1);
  });

  it("le profil modifié régénère le .htaccess (domaine final, forme canonique, page 404)", async () => {
    const res = await patch({ finalDomain: "https://www.Client-Exemple.fr", canonicalHost: "apex", notFoundPage: "/introuvable.html" });
    expect(res.statusCode).toBe(400);
    const ok = await patch({ finalDomain: "www.Client-Exemple.fr", canonicalHost: "apex", notFoundPage: "/introuvable.html" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ finalDomain: "client-exemple.fr", canonicalHost: "apex", notFoundPage: "/introuvable.html", serverConfig: { status: "generated" } });
    const content = (await htaccess())!;
    // Page absente des fichiers : directive commentée « À compléter », jamais écrite fausse.
    expect(content).toContain("# ErrorDocument 404 /introuvable.html");
    expect(content).not.toMatch(/^ErrorDocument/m);
    expect(content).toContain("RewriteRule ^ https://client-exemple.fr%{REQUEST_URI} [R=301,L,NE]");
    expect((await patch({ notFoundPage: "/../x.html" })).statusCode).toBe(400);
    expect((await patch({ canonicalHost: "autre" })).statusCode).toBe(400);
    const cleared = await patch({ finalDomain: null });
    expect(cleared.json().finalDomain).toBeNull();
    expect(await htaccess()).toContain("# À compléter : domaine final non renseigné dans l'onglet Serveur");
  });

  it("modification à la main : jamais réécrit sans force, état « modified », puis force", async () => {
    await upload(".htaccess", "# réglage maison\n");
    expect((await detail()).serverConfig.status).toBe("modified");
    const res = await patch({ finalDomain: "client.fr" });
    expect(res.json().serverConfig.status).toBe("modified");
    expect(await htaccess()).toBe("# réglage maison\n");
    expect(await audits("server-config.skip")).toBe(1);

    const refused = await regenerate();
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "server_config_modified", error: expect.stringMatching(/modifié à la main/) });
    expect(await htaccess()).toBe("# réglage maison\n");

    const forced = await regenerate(true);
    expect(forced.statusCode).toBe(200);
    expect(forced.json().serverConfig.status).toBe("generated");
    expect(await htaccess()).toContain("https://www.client.fr");
  });

  it("zip qui apporte son .htaccess : le zip gagne, état « modified », aucun écrasement ensuite", async () => {
    const zip = await makeZip([
      { name: "index.html", content: "<h1>x</h1>" },
      { name: ".htaccess", content: "# hébergeur\n" },
    ]);
    const res = await uploadZip(hub, siteId, zip, "merge");
    expect(res.json().accepted).toContain(".htaccess");
    expect((await detail()).serverConfig.status).toBe("modified");
    await patch({ notFoundPage: "/erreur.html" });
    expect(await htaccess()).toBe("# hébergeur\n");
  });

  it("suppression : état « missing », recréé seulement avec force", async () => {
    await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/files/delete`, headers: hub.headers, payload: { paths: [".htaccess"] } });
    expect((await detail()).serverConfig.status).toBe("missing");
    await patch({ finalDomain: "client.fr" });
    expect(await htaccess()).toBeNull();
    const refused = await regenerate();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/supprimé/);
    expect((await regenerate(true)).json().serverConfig.status).toBe("generated");
    expect(await htaccess()).toContain("client\\.fr");
  });

  it("régénération sans force quand le fichier est intact", async () => {
    const res = await regenerate();
    expect(res.statusCode).toBe(200);
    expect(res.json().serverConfig.status).toBe("generated");
  });

  it("aperçu : .htaccess et fichiers Pages fusionnés, sans rien écrire", async () => {
    await upload("_headers", "/*\n  Cache-Control: no-store\n");
    const preview = (await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/server-config/preview`, headers: hub.headers })).json() as ServerConfigPreview;
    expect(preview.htaccess.startsWith(GENERATED_MARKER)).toBe(true);
    expect(preview.hubCacheRules).toBe(false);
    expect(preview.pagesHeaders).toBe("# Règles du site\n/*\n  Cache-Control: no-store\n");
    expect(preview.pagesRedirects).toBeNull();
  });
});

describe("déploiement sur Pages", () => {
  it("n'envoie pas le .htaccess, copie la page 404 du profil en 404.html, cache dans le worker", async () => {
    await patch({ notFoundPage: "/introuvable.html" });
    await upload("index.html", "<h1>x</h1>");
    await upload("introuvable.html", "<h1>404</h1>");
    expect((await detail()).serverConfig.notFoundPagePresent).toBe(true);
    await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/publish`, headers: hub.headers, payload: {} });
    await settle(hub);
    const deployment = hub.cf.deployments("kz-alpha").at(-1)!;
    expect(Object.keys(deployment.manifest).sort()).toEqual(["/404.html", "/index.html", "/introuvable.html"]);
    expect(deployment.manifest["/404.html"]).toBe(deployment.manifest["/introuvable.html"]);
    expect(deployment.workerJs).toContain("max-age=31536000, immutable");
    expect(deployment.headersFile).toContain("/assets/*");
  });
});

/** Fichiers d'un zip d'export, en texte. */
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

const publishNow = async () => {
  const res = await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/publish`, headers: hub.headers, payload: {} });
  await settle(hub);
  return res;
};
/** .htaccess de la version servie (ce qui part à l'export), lu dans ses fichiers. */
const servedHtaccess = async () => {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
  const file = await prisma.versionFile.findFirst({ where: { versionId: site.currentVersionId!, path: ".htaccess" } });
  return file ? (await hub.services.blobs.read(file.sha256)).toString("utf8") : null;
};

describe(".htaccess qui suit le contenu publié (retour de production du 19/10/2026)", () => {
  it("site Astro construit, puis ajout de 404.html : le .htaccess généré évolue à chaque publication ; export sans « null »", async () => {
    await uploadFiles(hub, siteId, [
      { filename: "index.html", content: "<!doctype html><title>Accueil</title><h1>Accueil</h1>" },
      { filename: "_astro/index.B1x2.css", content: "h1{color:red}" },
      { filename: "sitemap-index.xml", content: '<?xml version="1.0"?><sitemapindex/>' },
    ]);
    expect((await publishNow()).statusCode).toBe(200);
    const first = (await servedHtaccess())!;
    expect(first).toContain('SetEnvIf Request_URI "^/(?:_astro)/" HUB_PATH_CACHE');
    expect(first).toContain("# Sitemap présent (/sitemap-index.xml)");
    expect(first).toContain("# ErrorDocument 404 /404.html");
    expect(first).not.toMatch(/^ErrorDocument/m);
    expect((await detail()).serverConfig).toMatchObject({ status: "generated", outdated: false, notFoundPagePresent: false });

    // 404.html ajouté : l'état le signale, la publication suivante met le .htaccess à jour.
    await uploadFiles(hub, siteId, [{ filename: "404.html", content: "<!doctype html><title>Introuvable</title><h1>Page introuvable</h1>" }]);
    expect((await detail()).serverConfig).toMatchObject({ status: "generated", outdated: true, notFoundPagePresent: true });
    expect((await publishNow()).statusCode).toBe(200);
    const second = (await servedHtaccess())!;
    expect(second).toMatch(/^ErrorDocument 404 \/404\.html$/m);
    expect(second).not.toContain("# ErrorDocument 404");
    expect(second).not.toBe(first);
    expect((await detail()).serverConfig).toMatchObject({ status: "generated", outdated: false });
    expect(await htaccess()).toBe(second);
    expect(await prisma.auditEvent.count({ where: { action: "server-config.generate", detail: "publication : contenu du site changé" } })).toBe(2);

    // Export Hostinger : .htaccess généré d'après la version exportée, aucune valeur null ni undefined.
    const res = await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/export?target=hostinger`, headers: hub.headers });
    expect(res.statusCode).toBe(200);
    const exported = (await unzip(res.rawPayload)).get(".htaccess")!;
    expect(exported).toBeDefined();
    expect(exported).not.toMatch(/\bnull\b|\bundefined\b/);
    expect(exported).toMatch(/^ErrorDocument 404 \/404\.html$/m);
    expect(exported).toContain('SetEnvIf Request_URI "^/(?:_astro)/" HUB_PATH_CACHE');
  });

  it(".htaccess modifié à la main : jamais écrasé à la publication, « la configuration générée a changé » signalé", async () => {
    await uploadFiles(hub, siteId, [
      { filename: "index.html", content: "<!doctype html><title>A</title><h1>A</h1>" },
      { filename: ".htaccess", content: "# réglage maison\nOptions -Indexes\n" },
    ]);
    expect((await publishNow()).statusCode).toBe(200);
    expect((await servedHtaccess())).toBe("# réglage maison\nOptions -Indexes\n");
    await uploadFiles(hub, siteId, [{ filename: "404.html", content: "<!doctype html><title>404</title><h1>404</h1>" }]);
    expect((await detail()).serverConfig).toMatchObject({ status: "modified", outdated: true });
    expect((await publishNow()).statusCode).toBe(200);
    expect(await servedHtaccess()).toBe("# réglage maison\nOptions -Indexes\n");
  });
});

describe("envoi d'un site complet : « Remplacer tout le contenu » (retour de production du 19/10/2026)", () => {
  const VITE_TEMPLATE = [
    { filename: "index.html", content: '<!doctype html><html><head><title>vite-project</title></head><body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>' },
    { filename: "vite.svg", content: "<svg/>" },
    { filename: "src/main.js", content: "document.querySelector('#app').innerHTML = 'Vite'" },
  ];
  const NEW_SITE = [
    { filename: "index.html", content: "<!doctype html><title>Kouzia</title><h1>Kouzia</h1>" },
    { filename: "_astro/index.B1x2.css", content: "h1{}" },
    { filename: "404.html", content: "<!doctype html><title>Introuvable</title><h1>Introuvable</h1>" },
  ];
  const paths = async () =>
    ((await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/files`, headers: hub.headers })).json() as { files: Array<{ path: string }> }).files.map((f) => f.path).sort();

  it("reproduit le mélange : en « Ajouter », l'ancien index.html Vite reste ; en « Remplacer », plus rien de l'ancien", async () => {
    await uploadFiles(hub, siteId, VITE_TEMPLATE);
    // Comportement d'avant (ajout) : les fichiers du modèle Vite restent mêlés au nouveau site.
    await uploadFiles(hub, siteId, NEW_SITE.filter((f) => f.filename !== "index.html"));
    // src/main.js du modèle : refusé à l'envoi depuis le 19/10/2026 (sources à la racine).
    expect(await paths()).toEqual([".htaccess", "404.html", "_astro/index.B1x2.css", "index.html", "vite.svg"]);
    expect((await htaccessOf("index.html"))).toContain("vite-project");

    // Remplacer tout le contenu : la version de travail devient exactement l'envoi (+ le .htaccess généré, gardé).
    const res = await uploadFiles(hub, siteId, NEW_SITE, undefined, "replace");
    expect(res.statusCode).toBe(200);
    const body = res.json() as UploadResult;
    expect(body.removed).toBe(1);
    expect(await paths()).toEqual([".htaccess", "404.html", "_astro/index.B1x2.css", "index.html"]);
    expect(await htaccessOf("index.html")).not.toContain("vite-project");
    expect((await detail()).serverConfig.status).toBe("generated");
    expect(await prisma.auditEvent.findFirst({ where: { action: "files.upload", siteId }, orderBy: { at: "desc" } })).toMatchObject({
      detail: "3 fichier(s), contenu remplacé, 1 retiré(s)",
    });
  });

  it("« Remplacer » : racine seulement ; refusé pendant une opération (verrou du site) ; un .htaccess envoyé remplace le généré", async () => {
    const sub = await uploadFiles(hub, siteId, NEW_SITE, "sous-dossier", "replace");
    expect(sub.statusCode).toBe(400);
    expect(sub.json().error).toMatch(/racine du site seulement/);

    await uploadFiles(hub, siteId, VITE_TEMPLATE);
    const release = await hub.services.engine.acquire(siteId);
    const locked = await uploadFiles(hub, siteId, NEW_SITE, undefined, "replace");
    release();
    expect(locked.statusCode).toBe(409);
    expect(await paths()).toContain("vite.svg");

    const own = await uploadFiles(hub, siteId, [...NEW_SITE, { filename: ".htaccess", content: "# réglage maison\n" }], undefined, "replace");
    expect(own.statusCode).toBe(200);
    expect(await htaccessOf(".htaccess")).toBe("# réglage maison\n");
    expect((await detail()).serverConfig.status).toBe("modified");
  });

  it("zip en « Remplacer » : même purge, nombre de fichiers retirés renvoyé", async () => {
    await uploadFiles(hub, siteId, VITE_TEMPLATE);
    const zip = await makeZip(NEW_SITE.map((f) => ({ name: f.filename, content: f.content })));
    const res = await uploadZip(hub, siteId, zip, "replace");
    expect(res.statusCode).toBe(200);
    expect((res.json() as UploadResult).removed).toBe(1);
    expect(await paths()).toEqual([".htaccess", "404.html", "_astro/index.B1x2.css", "index.html"]);
  });
});

/** Contenu d'un fichier de travail. */
async function htaccessOf(path: string): Promise<string | null> {
  const res = await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/files/raw?path=${encodeURIComponent(path)}`, headers: hub.headers });
  return res.statusCode === 200 ? res.body : null;
}

describe("fichiers de développement et CSP du site (retour de production du 19/10/2026)", () => {
  /** Reste d'un envoi d'avant la règle : écrit directement dans la version de travail. */
  async function leftover(path: string, content: string) {
    const blob = await hub.services.blobs.putBuffer(Buffer.from(content));
    await prisma.workingFile.create({ data: { siteId, path, sha256: blob.sha256, size: blob.size } });
  }
  const filesOf = async () => (await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/files`, headers: hub.headers })).json() as { devFiles: string[]; files: Array<{ path: string }> };
  const publishNow = async (payload: Record<string, unknown> = {}) => {
    const res = await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/publish`, headers: hub.headers, payload });
    await settle(hub);
    return res;
  };

  it("package.json resté d'un ancien envoi : signalé, jamais déployé ni exporté, « Nettoyer » le retire après confirmation", async () => {
    await uploadFiles(hub, siteId, [
      { filename: "index.html", content: "<!doctype html><title>Portfolio</title><h1>Portfolio</h1>" },
      { filename: "404.html", content: "<!doctype html><title>404</title><h1>Introuvable</h1>" },
    ]);
    await leftover("package.json", '{ "name": "vite-project" }');
    await leftover("src/main.js", "console.log(1)");
    expect((await filesOf()).devFiles).toEqual(["package.json", "src/main.js"]);

    expect((await publishNow()).statusCode).toBe(200);
    const deployment = hub.cf.deployments("kz-alpha").at(-1)!;
    expect(Object.keys(deployment.manifest).sort()).toEqual(["/404.html", "/index.html"]);
    expect(deployment.workerJs).toContain("const HAS_404 = true;");
    expect(deployment.workerJs).toContain("frame-ancestors 'self'; object-src 'none'; base-uri 'self'; upgrade-insecure-requests");

    const exportRes = await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/export?target=hostinger`, headers: hub.headers });
    const exported = await unzip(exportRes.rawPayload);
    expect(exported.has("package.json")).toBe(false);
    expect(exported.has("src/main.js")).toBe(false);
    expect(exported.get(".htaccess")).toContain("RewriteRule ^src(?:/|$) - [F,L,NC]");
    expect(exported.get(".htaccess")).toMatch(/<FilesMatch "\(\?i\)\^\(\?:package\\.json\|/);

    const noConfirm = await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/files/clean-dev`, headers: hub.headers, payload: {} });
    expect(noConfirm.statusCode).toBe(400);
    const cleaned = await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/files/clean-dev`, headers: hub.headers, payload: { confirm: true } });
    expect(cleaned.statusCode).toBe(200);
    expect((cleaned.json() as { devFiles: string[] }).devFiles).toEqual([]);
    expect((await filesOf()).files.map((f) => f.path).sort()).toEqual([".htaccess", "404.html", "index.html"]);
    expect(await prisma.auditEvent.findFirst({ where: { action: "files.clean-dev", siteId } })).toMatchObject({ detail: "2 fichier(s) : package.json, src/main.js" });
  });

  it("règles du site (colonnes Site) : chemins exacts, CSP ajoutée sans affaiblir frame-ancestors et object-src", async () => {
    expect((await patch({ siteCsp: 'default-src "self"' })).json()).toMatchObject({ code: "site_csp" });
    expect((await patch({ siteCsp: "pas une csp !" })).json().error).toMatch(/directive inconnue : « pas »/);
    expect((await patch({ siteCsp: "default-src 'self';\nimg-src *" })).json().error).toMatch(/saut de ligne/);
    expect((await patch({ devFilesAllowed: ["../x.json"] })).json()).toMatchObject({ code: "dev_files_allowed" });
    expect((await patch({ devFilesAllowed: ["src/"] })).json().error).toMatch(/ni dossier, ni joker/);
    expect((await patch({ devFilesAllowed: ["data/*.json"] })).json().error).toMatch(/ni dossier, ni joker/);
    expect((await patch({ devFilesAllowed: Array.from({ length: 51 }, (_, i) => `f${i}.json`) })).statusCode).toBe(400);

    const ok = await patch({
      devFilesAllowed: ["/data/package.json", "src/app.js", "src/app.js"],
      siteCsp: "  default-src 'self';   img-src 'self' data: ; frame-ancestors *; object-src *  ",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ devFilesAllowed: ["data/package.json", "src/app.js"], siteCsp: "default-src 'self'; img-src 'self' data:; frame-ancestors *; object-src *" });
    expect(await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { devFilesAllowed: true, siteCsp: true } })).toEqual({
      devFilesAllowed: "data/package.json\nsrc/app.js",
      siteCsp: "default-src 'self'; img-src 'self' data:; frame-ancestors *; object-src *",
    });
    // .htaccess : CSP du hub complétée, frame-ancestors et object-src du hub gardées ; src/app.js excepté de la règle src/.
    const h = (await htaccess())!;
    const csp = /Content-Security-Policy "([^"]+)"/.exec(h)![1]!;
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).not.toContain("frame-ancestors *");
    expect(h).toContain("    RewriteCond %{REQUEST_URI} !^/src/app\\.js$\n    RewriteRule ^src(?:/|$) - [F,L,NC]");

    const sent = (await uploadFiles(hub, siteId, [
      { filename: "index.html", content: "<h1>x</h1>" },
      { filename: "data/package.json", content: "{}" },
      { filename: "src/app.js", content: "x" },
      { filename: "src/autre.js", content: "x" },
      { filename: "package.json", content: "{}" },
    ])).json() as UploadResult;
    expect(sent.accepted.sort()).toEqual(["data/package.json", "index.html", "src/app.js"]);
    expect(sent.rejected.map((r) => r.path).sort()).toEqual(["package.json", "src/autre.js"]);
    expect((await publishNow()).statusCode).toBe(200);
    const worker = hub.cf.deployments("kz-alpha").at(-1)!.workerJs;
    expect(worker).toContain('const ALLOW = ["data/package.json","src/app.js"];');
    expect(worker).toContain(
      `"Content-Security-Policy":"frame-ancestors 'self'; object-src 'none'; base-uri 'self'; upgrade-insecure-requests; default-src 'self'; img-src 'self' data:"`,
    );

    // Vidées : retour aux valeurs par défaut (colonnes à null).
    expect((await patch({ devFilesAllowed: [], siteCsp: "" })).json()).toMatchObject({ devFilesAllowed: [], siteCsp: null });
    expect(await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { devFilesAllowed: true, siteCsp: true } })).toEqual({ devFilesAllowed: null, siteCsp: null });
  });
});

describe("option « Autoriser l'indexation » (cinquième série, 22/10/2026)", () => {
  it("désactivée par défaut ; activée, le déploiement suivant n'a plus de noindex et pointe vers le sitemap ; journalisée", async () => {
    expect((await detail()).allowIndexing).toBe(false);
    await uploadFiles(hub, siteId, [
      { filename: "index.html", content: "<!doctype html><title>Tracebay</title><h1>Tracebay</h1>" },
      { filename: "sitemap-index.xml", content: "<sitemapindex/>" },
    ]);
    const publish = async () => {
      const res = await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/publish`, headers: hub.headers, payload: {} });
      await settle(hub);
      return res;
    };
    expect((await publish()).statusCode).toBe(200);
    expect(hub.cf.deployments("kz-alpha").at(-1)!.workerJs).toContain('"X-Robots-Tag":"noindex, nofollow"');

    expect((await patch({ allowIndexing: "oui" })).statusCode).toBe(400);
    const on = await patch({ allowIndexing: true });
    expect(on.json()).toMatchObject({ allowIndexing: true });
    expect(await prisma.auditEvent.findFirst({ where: { action: "site.indexing", siteId } })).toMatchObject({ detail: "indexation autorisée" });
    const site = await detail();
    const republished = await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/versions/${site.currentVersion!.id}/publish`, headers: hub.headers });
    await settle(hub);
    expect(republished.statusCode).toBe(200);
    const worker = hub.cf.deployments("kz-alpha").at(-1)!.workerJs;
    expect(worker).not.toContain('"HEADERS":');
    expect(worker).toMatch(/const HEADERS = \{(?![^}]*X-Robots-Tag)[^}]*\};/);
    expect(worker).toContain("Sitemap: https://alpha.kouzia.com/sitemap-index.xml");
    expect(worker).toMatch(/const REDIRECT_HEADERS = \{[^}]*"X-Robots-Tag":"noindex, nofollow"/);
  });
});
