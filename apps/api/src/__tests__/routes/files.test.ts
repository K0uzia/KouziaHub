import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FilesResponse, SiteDetail, UploadResult, VersionEntry } from "@/contract.js";
import { prisma, resetDb } from "../helpers/db.js";
import { buildTestHub, createPersoSite, uploadFiles, uploadZip, makeZip, patchName, patchUncompressedSize, settle, type MultipartFile, type TestHub } from "../helpers/hub.js";

let hub: TestHub;
let siteId: string;

beforeEach(async () => {
  await resetDb();
  hub = await buildTestHub();
  siteId = await createPersoSite(hub, "alpha");
  // Le .htaccess généré à la création est testé à part (server-config.test.ts) : retiré ici pour des comptes simples.
  await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/files/delete`, headers: hub.headers, payload: { paths: [".htaccess"] } });
});
afterEach(async () => {
  await hub.app.close();
});

// Envoi comme l'interface : par session (l'ancienne route multipart est retirée).
const upload = (files: MultipartFile[], dir?: string) => uploadFiles(hub, siteId, files, dir);

// Zip envoyé comme l'interface : session zip, morceaux, finalisation (l'ancienne route /zip est retirée).
const sendZip = (zip: Buffer, mode: string) => uploadZip(hub, siteId, zip, mode);

const files = async () => (await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/files`, headers: hub.headers })).json() as FilesResponse;
const paths = async () => (await files()).files.map((f) => f.path);
const detail = async () => (await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}`, headers: hub.headers })).json() as SiteDetail;
const versions = async () => (await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/versions`, headers: hub.headers })).json() as VersionEntry[];

async function publish(note?: string) {
  const res = await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/publish`, headers: hub.headers, payload: note ? { note } : {} });
  await settle(hub);
  return res;
}

describe("explorateur de fichiers", () => {
  it("envoie des fichiers dans un dossier, sous-dossiers compris, et écarte les interdits avec une raison", async () => {
    const res = await upload(
      [
        { filename: "app.css", content: "body{}" },
        { filename: "img/logo.svg", content: "<svg/>" },
        { filename: ".env", content: "SECRET=1" },
        { filename: ".DS_Store", content: "x" },
        { filename: "../../evil.txt", content: "x" },
        { filename: "a\\b.txt", content: "x" },
      ],
      "assets",
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as UploadResult;
    expect(body.accepted.sort()).toEqual(["assets/app.css", "assets/img/logo.svg"]);
    expect(body.rejected).toHaveLength(4);
    expect(body.rejected.find((r) => r.path === "assets/.env")?.reason).toMatch(/\.env/);
    expect(body.rejected.find((r) => r.path === "assets/.DS_Store")?.reason).toMatch(/système/);
    // Page d'attente servie et pas d'index.html : rien à publier, donc pas « modifié ».
    expect(body.files).toMatchObject({ hasIndex: false, workingDirty: false, totalBytes: 12, limits: { maxFiles: 20000 } });
  });

  it("refuse _worker.js envoyé à la racine et un dossier cible piégé", async () => {
    const res = await upload([{ filename: "_worker.js", content: "export default {}" }]);
    expect((res.json() as UploadResult).rejected[0]!.reason).toMatch(/hub injecte/);
    const trap = await upload([{ filename: "x.txt", content: "x" }], "../up");
    expect(trap.statusCode).toBe(400);
  });

  it("remplace un fichier existant (même chemin)", async () => {
    await upload([{ filename: "index.html", content: "v1" }]);
    await upload([{ filename: "index.html", content: "version 2" }]);
    const list = await files();
    expect(list.files).toHaveLength(1);
    expect(list.files[0]!.size).toBe(9);
  });

  it("refuse un nom qui ne diffère d'un fichier existant que par la casse (envoi et renommage)", async () => {
    await upload([{ filename: "index.html", content: "i" }]);
    const res = await upload([
      { filename: "Index.html", content: "x" },
      { filename: "page.html", content: "p" },
      { filename: "PAGE.html", content: "p2" },
    ]);
    const body = res.json() as UploadResult;
    expect(body.accepted).toEqual(["page.html"]);
    // PAGE.html : écarté dès l'ouverture de la session (doublon dans l'envoi) ; Index.html : à la finalisation.
    expect(body.rejected).toEqual(
      expect.arrayContaining([
        { path: "Index.html", reason: "Un fichier « index.html » existe déjà avec le même nom à la casse près." },
        { path: "PAGE.html", reason: expect.stringMatching(/casse/) },
      ]),
    );
    expect(body.rejected).toHaveLength(2);
    expect((await paths()).sort()).toEqual(["index.html", "page.html"]);
    const move = await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/files/move`, headers: hub.headers, payload: { from: "page.html", to: "INDEX.html" } });
    expect(move.statusCode).toBe(409);
    expect(move.json().error).toMatch(/casse/);
  });

  it("télécharge en pièce jointe, jamais en ligne, même un HTML", async () => {
    await upload([{ filename: "index.html", content: "<script>alert(1)</script>" }]);
    const res = await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/files/raw?path=index.html`, headers: hub.headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="index.html"/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toMatch(/sandbox/);
    expect(res.body).toBe("<script>alert(1)</script>");
    const trap = await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/files/raw?path=../index.html`, headers: hub.headers });
    expect(trap.statusCode).toBe(400);
    const missing = await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/files/raw?path=absent.html`, headers: hub.headers });
    expect(missing.statusCode).toBe(404);
  });

  it("supprime fichiers et dossiers (« / » final), sans toucher aux noms voisins", async () => {
    await upload([
      { filename: "index.html", content: "i" },
      { filename: "assets/a.css", content: "a" },
      { filename: "assets/img/b.png", content: "b" },
      { filename: "assets-old/c.css", content: "c" },
      { filename: "Assets/d.css", content: "d" },
    ]);
    const res = await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/files/delete`, headers: hub.headers, payload: { paths: ["assets/", "index.html"] } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as FilesResponse).files.map((f) => f.path).sort()).toEqual(["Assets/d.css", "assets-old/c.css"]);
    const trap = await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/files/delete`, headers: hub.headers, payload: { paths: ["../x"] } });
    expect(trap.statusCode).toBe(400);
  });

  it("renomme un fichier ou un dossier ; refuse l'écrasement et les destinations interdites", async () => {
    await upload([
      { filename: "index.html", content: "i" },
      { filename: "old/a.css", content: "a" },
      { filename: "old/sub/b.css", content: "b" },
      { filename: "taken.html", content: "t" },
    ]);
    const move = (from: string, to: string) => hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/files/move`, headers: hub.headers, payload: { from, to } });
    expect((await move("old/", "new/")).statusCode).toBe(200);
    expect((await paths()).sort()).toEqual(["index.html", "new/a.css", "new/sub/b.css", "taken.html"]);
    expect((await move("index.html", "taken.html")).statusCode).toBe(409);
    expect((await move("index.html", "_worker.js")).statusCode).toBe(400);
    expect((await move("index.html", "../x.html")).statusCode).toBe(400);
    expect((await move("new/", "new/inner/")).statusCode).toBe(400);
    expect((await move("absent.html", "b.html")).statusCode).toBe(404);
    expect((await move("index.html", "accueil.html")).statusCode).toBe(200);
    expect(await paths()).toContain("accueil.html");
  });
});

describe("envoi d'un zip", () => {
  it("mode replace : remplace tout, retire le dossier racine unique et liste les écartés", async () => {
    await upload([{ filename: "ancien.html", content: "x" }]);
    const zip = await makeZip([
      { name: "dist/index.html", content: "<h1>v1</h1>" },
      { name: "dist/assets/app.js", content: "1" },
      { name: "dist/assets/app.js.map", content: "{}" },
      { name: "dist/.DS_Store", content: "x" },
    ]);
    const res = await sendZip(zip, "replace");
    expect(res.statusCode).toBe(200);
    const body = res.json() as UploadResult;
    expect(body.strippedRoot).toBe("dist/");
    expect(body.accepted.sort()).toEqual(["assets/app.js", "index.html"]);
    expect(body.rejected.map((r) => r.path).sort()).toEqual([".DS_Store", "assets/app.js.map"]);
    expect((await paths()).sort()).toEqual(["assets/app.js", "index.html"]);
    expect(body.files.hasIndex).toBe(true);
  });

  it("mode merge : ajoute et remplace sans supprimer le reste", async () => {
    await upload([
      { filename: "index.html", content: "ancien" },
      { filename: "garde.css", content: "x" },
    ]);
    await sendZip(await makeZip([{ name: "index.html", content: "nouveau" }]), "merge");
    expect((await paths()).sort()).toEqual(["garde.css", "index.html"]);
    expect((await files()).files.find((f) => f.path === "index.html")!.size).toBe(7);
  });

  it("mode merge : collision de casse avec un fichier existant écartée avec sa raison ; mode replace : acceptée", async () => {
    await upload([{ filename: "index.html", content: "ancien" }]);
    const zip = await makeZip([
      { name: "Index.html", content: "nouveau" },
      { name: "a.css", content: "a" },
    ]);
    const merged = (await sendZip(zip, "merge")).json() as UploadResult;
    expect(merged.accepted).toEqual(["a.css"]);
    expect(merged.rejected).toEqual([{ path: "Index.html", reason: expect.stringMatching(/casse/) }]);
    expect((await paths()).sort()).toEqual(["a.css", "index.html"]);
    const replaced = (await sendZip(zip, "replace")).json() as UploadResult;
    expect(replaced.accepted.sort()).toEqual(["Index.html", "a.css"]);
  });

  it("archive piégée : refusée en entier, version de travail intacte (tout ou rien)", async () => {
    await upload([{ filename: "index.html", content: "intact" }]);
    const before = await files();
    const traversal = patchName(await makeZip([{ name: "index.html", content: "a" }, { name: "XX/evil.txt", content: "b" }]), "XX/evil.txt", "../evil.txt");
    const bomb = patchUncompressedSize(await makeZip([{ name: "index.html", content: Buffer.alloc(30 * 1024 * 1024) }]), 10);
    for (const zip of [traversal, bomb]) {
      const res = await sendZip(zip, "replace");
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/^Archive refusée/);
    }
    expect(await files()).toEqual(before);
    expect(await prisma.auditEvent.count({ where: { action: "files.zip", result: "error" } })).toBe(2);
  });

  it("exige le champ mode et un vrai zip", async () => {
    expect((await sendZip(await makeZip([{ name: "index.html", content: "a" }]), "tout")).statusCode).toBe(400);
    expect((await sendZip(Buffer.from("pas un zip"), "merge")).statusCode).toBe(400);
  });
});

describe("publication : délai dépassé après création du déploiement", () => {
  async function failedPublish() {
    await upload([{ filename: "index.html", content: "<h1>v</h1>" }]);
    const project = (await detail()).pagesProject;
    const before = hub.cf.deployments(project).length;
    hub.cf.failAfterNext("deploy");
    await publish("première tentative");
    const failed = await detail();
    expect(failed.operation?.status).toBe("FAILED");
    // Cloudflare a bien créé le déploiement, le hub ne le sait pas.
    expect(hub.cf.deployments(project)).toHaveLength(before + 1);
    return { project, before, failed };
  }
  const tracked = async () => (await prisma.version.findMany({ where: { siteId, cfDeploymentId: { not: null } } })).map((v) => v.cfDeploymentId);

  it("la reprise rattache le déploiement créé : un seul déploiement suivi, aucun orphelin", async () => {
    const { project, failed } = await failedPublish();
    const created = hub.cf.deployments(project).at(-1)!.id;
    const deploys = () => hub.cf.calls.filter((c) => c.startsWith("deploy:")).length;
    const deploysBefore = deploys();
    const retry = await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/operations/${failed.operation!.id}/retry`, headers: hub.headers });
    expect(retry.statusCode).toBe(200);
    await settle(hub);
    // Aucun nouveau déploiement : celui de la première tentative est rattaché à la version.
    expect(deploys()).toBe(deploysBefore);
    const version = (await prisma.version.findMany({ where: { siteId, note: "première tentative" } }))[0]!;
    expect(version.cfDeploymentId).toBe(created);
    expect(version.status).toBe("PUBLISHED");
    // Plus aucun déploiement inconnu du hub (la page d'attente, elle, est purgée par la rétention).
    const deployments = hub.cf.deployments(project);
    const known = await tracked();
    for (const d of deployments) expect(known).toContain(d.id);
    const site = await detail();
    expect(site.operation).toBeNull();
    expect(site.currentVersion?.number).toBe((await versions()).find((v) => v.note === "première tentative")!.number);
  });

  it("deux déploiements restés de la tentative : le plus récent est rattaché, l'autre supprimé", async () => {
    const { project, failed } = await failedPublish();
    const first = hub.cf.deployments(project).at(-1)!.id;
    // Appel rejoué par le client HTTP après une coupure : un second déploiement identique.
    await hub.cf.deploy(project, { files: [], workerJs: "// doublon" });
    const newest = hub.cf.deployments(project).at(-1)!.id;
    await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/operations/${failed.operation!.id}/retry`, headers: hub.headers });
    await settle(hub);
    const deployments = hub.cf.deployments(project).map((d) => d.id);
    expect(deployments).toContain(newest);
    expect(deployments).not.toContain(first);
    expect(hub.cf.calls).toContain(`deleteDeployment:${first}`);
    const known = await tracked();
    for (const id of deployments) expect(known).toContain(id);
  });
});

describe("publication et versions", () => {
  it("refuse sans index.html à la racine", async () => {
    await upload([{ filename: "page.html", content: "x" }]);
    const res = await publish();
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/index\.html/);
  });

  it("publie un instantané : _headers à part, version servie, travail à jour", async () => {
    await upload([
      { filename: "index.html", content: "<h1>v1</h1>" },
      { filename: "_headers", content: "/*\n  X-Client: 1\n" },
      { filename: "_redirects", content: "/old /new 301\n" },
    ]);
    expect((await detail()).workingDirty).toBe(true);
    const res = await publish("Première version");
    expect(res.statusCode).toBe(200);
    const site = await detail();
    expect(site).toMatchObject({ workingDirty: false, currentVersion: { number: 2 } });
    const deployment = hub.cf.deployments("kz-alpha").at(-1)!;
    expect(Object.keys(deployment.manifest)).toEqual(["/index.html"]);
    // Règles de cache du hub d'abord, puis celles du site.
    expect(deployment.headersFile).toBe(
      "# Hub Kouzia : cache des fichiers au nom hashé (sécurité et autres règles : _worker.js).\n" +
        "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n/_astro/*\n  Cache-Control: public, max-age=31536000, immutable\n\n" +
        "# Règles du site\n/*\n  X-Client: 1\n",
    );
    expect(deployment.redirectsFile).toBe("/old /new 301\n");
    expect(deployment.workerJs).toContain('"alpha.kouzia.com"');
    const list = await versions();
    expect(list[0]).toMatchObject({ number: 2, note: "Première version", source: "files", status: "PUBLISHED", current: true, fileCount: 3 });
    expect(list[1]).toMatchObject({ number: 1, source: "placeholder", status: "PURGED", current: false });
    expect(await prisma.auditEvent.findFirst({ where: { action: "version.publish" } })).toMatchObject({ result: "ok", detail: "version 2" });

    await upload([{ filename: "index.html", content: "<h1>v2</h1>" }]);
    expect((await detail()).workingDirty).toBe(true);
  });

  it("source « zip » quand le dernier changement vient d'un zip", async () => {
    await sendZip(await makeZip([{ name: "index.html", content: "z" }]), "replace");
    await publish();
    expect((await versions())[0]!.source).toBe("zip");
  });

  it("échec d'envoi : version FAILED, reprise de l'opération", async () => {
    await upload([{ filename: "index.html", content: "x" }]);
    hub.cf.failNext("deploy");
    await publish();
    const failed = await detail();
    expect(failed.operation).toMatchObject({ kind: "PUBLISH", status: "FAILED" });
    expect((await versions())[0]).toMatchObject({ status: "FAILED", error: expect.any(String) });
    await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/operations/${failed.operation!.id}/retry`, headers: hub.headers });
    await settle(hub);
    expect((await versions())[0]).toMatchObject({ status: "PUBLISHED", current: true });
  });

  it("rétention : 10 versions de contenu gardées, déploiements plus anciens supprimés, jamais celui servi", async () => {
    for (let i = 1; i <= 12; i++) {
      await upload([{ filename: "index.html", content: `<h1>${i}</h1>` }]);
      expect((await publish()).statusCode).toBe(200);
    }
    const list = await versions();
    expect(list).toHaveLength(13);
    const published = list.filter((v) => v.status === "PUBLISHED");
    expect(published.map((v) => v.number)).toEqual([13, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
    expect(list.filter((v) => v.status === "PURGED").map((v) => v.number)).toEqual([3, 2, 1]);
    expect(hub.cf.deployments("kz-alpha")).toHaveLength(10);
    expect(await prisma.versionFile.count({ where: { version: { status: "PURGED" } } })).toBe(0);
    expect(list[0]!.current).toBe(true);
  }, 20_000);

  it("rétention : une version en échec ne prend pas la place d'une version publiée", async () => {
    for (let i = 1; i <= 10; i++) {
      await upload([{ filename: "index.html", content: `<h1>${i}</h1>` }]);
      await publish();
    }
    await upload([{ filename: "index.html", content: "<h1>échec</h1>" }]);
    hub.cf.failNext("deploy");
    await publish();
    await upload([{ filename: "index.html", content: "<h1>12</h1>" }]);
    expect((await publish()).statusCode).toBe(200);
    const list = await versions();
    expect(list.filter((v) => v.status === "PUBLISHED").map((v) => v.number)).toEqual([13, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(list.find((v) => v.number === 12)).toMatchObject({ status: "PURGED", error: expect.any(String) });
    expect(hub.cf.deployments("kz-alpha")).toHaveLength(10);
  }, 20_000);

  it("republie une version gardée, puis la restaure en version de travail", async () => {
    await upload([{ filename: "index.html", content: "<h1>A</h1>" }]);
    await publish("A");
    await upload([{ filename: "index.html", content: "<h1>B</h1>" }]);
    await publish("B");
    const [b, a] = await versions();
    expect(b!.note).toBe("B");

    const res = await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/versions/${a!.id}/publish`, headers: hub.headers });
    expect(res.statusCode).toBe(200);
    await settle(hub);
    const list = await versions();
    expect(list[0]).toMatchObject({ source: "republish", sourceVersionNumber: a!.number, current: true, status: "PUBLISHED" });
    // Travail (B) différent de la version servie (A) : modifié.
    expect((await detail()).workingDirty).toBe(true);
    expect(await prisma.auditEvent.findFirst({ where: { action: "version.republish" } })).toMatchObject({ result: "ok" });

    const restore = await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/versions/${a!.id}/restore`, headers: hub.headers });
    expect(restore.statusCode).toBe(200);
    expect((restore.json() as FilesResponse).workingDirty).toBe(false);
    const raw = await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/files/raw?path=index.html`, headers: hub.headers });
    expect(raw.body).toBe("<h1>A</h1>");
  });

  it("libère les blobs orphelins après suppression, garde ceux encore utilisés", async () => {
    await upload([
      { filename: "index.html", content: "garde" },
      { filename: "jetable.txt", content: "unique-a-supprimer" },
    ]);
    const list = await files();
    const kept = list.files.find((f) => f.path === "index.html")!.sha256;
    const dropped = list.files.find((f) => f.path === "jetable.txt")!.sha256;
    await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/files/delete`, headers: hub.headers, payload: { paths: ["jetable.txt"] } });
    await hub.services.blobs.gc(0);
    expect(existsSync(hub.services.blobs.pathOf(dropped))).toBe(false);
    expect(existsSync(hub.services.blobs.pathOf(kept))).toBe(true);
  });
});
