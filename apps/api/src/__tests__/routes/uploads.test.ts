import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FilesResponse, UploadFileDecl, UploadResult, UploadSession } from "@/contract.js";
import { UPLOAD_CHUNK_BYTES } from "@/lib/limits.js";
import { resetDb } from "../helpers/db.js";
import { buildTestHub, createPersoSite, makeZip, multipart, patchName, uploadFiles, type TestHub } from "../helpers/hub.js";

let hub: TestHub;
let siteId: string;

beforeEach(async () => {
  await resetDb();
  hub = await buildTestHub();
  siteId = await createPersoSite(hub, "portfolio");
  await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/files/delete`, headers: hub.headers, payload: { paths: [".htaccess"] } });
});
afterEach(async () => {
  await hub.app.close();
});

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const MIB = 1024 * 1024;

type LocalFile = { path: string; content: Buffer };

/** Jeu à la forme du portfolio d'Alexandre : dist de 90 fichiers, sources, node_modules, .git, .astro, gros fichiers. */
function portfolioLike(): LocalFile[] {
  const out: LocalFile[] = [];
  const add = (p: string, content: Buffer | string) => out.push({ path: `Portfolio/${p}`, content: Buffer.from(content) });
  add("dist/index.html", "<!doctype html><title>Portfolio</title>");
  for (let i = 1; i < 90; i++) add(`dist/${i % 3 ? "_astro" : "fr"}/page-${i}.${i % 2 ? "js" : "html"}`, `contenu ${i}`);
  add("package.json", '{"name":"portfolio"}');
  add("astro.config.mjs", "export default {}");
  for (let i = 0; i < 30; i++) add(`src/pages/p${i}.astro`, `---\n---\n<p>${i}</p>`);
  for (let i = 0; i < 250; i++) add(`node_modules/pkg-${i % 25}/lib/f${i}.js`, `module.exports = ${i}`);
  add("node_modules/@img/sharp-win32-x64/lib/libvips.dll", Buffer.alloc(26 * MIB, 1));
  for (let i = 0; i < 20; i++) add(`.git/objects/${i}`, `objet ${i}`);
  for (let i = 0; i < 3; i++) add(`.astro/types-${i}.d.ts`, `type T${i} = ${i};`);
  return out;
}

function decl(files: LocalFile[]): UploadFileDecl[] {
  return files.map((f) => ({ path: f.path, size: f.content.length, sha256: sha(f.content) }));
}

async function open(body: unknown) {
  return hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/uploads`, headers: hub.headers, payload: body as object });
}
async function put(uid: string, n: number, data: Buffer, hash = sha(data)) {
  return hub.app.inject({
    method: "PUT",
    url: `/api/sites/${siteId}/uploads/${uid}/chunks/${n}`,
    headers: { ...hub.headers, "content-type": "application/octet-stream", "x-chunk-sha256": hash },
    payload: data,
  });
}
const state = async (uid: string) => hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/uploads/${uid}`, headers: hub.headers });
const complete = (uid: string) => hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/uploads/${uid}/complete`, headers: hub.headers });
const workingPaths = async () =>
  ((await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/files`, headers: hub.headers })).json() as FilesResponse).files.map((f) => f.path);

/** Flux d'une session de fichiers : fichiers retenus bout à bout, découpés en morceaux. */
function streamOf(session: UploadSession, files: LocalFile[]): Buffer[] {
  const all = Buffer.concat(session.included.map((i) => files[i]!.content));
  const chunks: Buffer[] = [];
  for (let o = 0; o < all.length; o += session.chunkSize) chunks.push(all.subarray(o, o + session.chunkSize));
  return chunks;
}

describe("cas réel : dossier de projet (portfolio)", () => {
  it("plus de 1 000 fichiers dans un dossier : une session, tous reçus (le plafond de 1 000 parties ne joue plus)", async () => {
    const files = Array.from({ length: 1500 }, (_, i) => ({ filename: `a/f${i}.txt`, content: `x${i}` }));
    const res = await uploadFiles(hub, siteId, files, "lot");
    expect(res.statusCode).toBe(200);
    expect((res.json() as UploadResult).accepted).toHaveLength(1500);
  });

  it("au-delà du plafond du site : 413 avec un code et un message précis, jamais « Fichier trop volumineux. » seul", async () => {
    const files = Array.from({ length: 20_001 }, (_, i) => ({ path: `f${i}.txt`, size: 1, sha256: "b".repeat(64) }));
    const res = await open({ kind: "files", files });
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe("too_many_files");
    expect(res.json().error).toMatch(/20000 au plus par site/);
  });

  it("l'ancienne route d'envoi multipart est retirée", async () => {
    const body = multipart([], [{ field: "files", filename: "index.html", content: "x" }]);
    const res = await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/files`, headers: { ...hub.headers, ...body.headers }, payload: body.payload });
    expect(res.statusCode).toBe(404);
  });

  it("l'ancienne route d'envoi direct d'un zip est retirée", async () => {
    const zip = await makeZip([{ name: "index.html", content: "x" }]);
    const body = multipart([["mode", "merge"]], [{ field: "file", filename: "site.zip", content: zip, type: "application/zip" }]);
    const res = await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/zip`, headers: { ...hub.headers, ...body.headers }, payload: body.payload });
    expect(res.statusCode).toBe(404);
  });

  it("dossier complet par session : node_modules, .git, .astro et le fichier de 26 Mio écartés avec leur raison, le reste reçu", async () => {
    const local = portfolioLike();
    local.push({ path: "Portfolio/dist/video.mp4", content: Buffer.alloc(27 * MIB, 2) });
    const res = await open({ kind: "files", dir: "", files: decl(local) });
    expect(res.statusCode).toBe(200);
    const session = res.json() as UploadSession;
    const reasons = new Map(session.rejected.map((r) => [r.path, r.reason]));
    expect(reasons.get("Portfolio/node_modules/pkg-0/lib/f0.js")).toMatch(/node_modules refusé/);
    expect(reasons.get("Portfolio/.git/objects/0")).toMatch(/\.git refusé/);
    expect(reasons.get("Portfolio/.astro/types-0.d.ts")).toMatch(/\.astro refusé/);
    expect(reasons.get("Portfolio/dist/video.mp4")).toMatch(/27,0 Mio.*25 Mio/);
    expect(session.rejected).toHaveLength(250 + 1 + 20 + 3 + 1);
    expect(session.included).toHaveLength(90 + 2 + 30);
    for (const [n, chunk] of streamOf(session, local).entries()) expect((await put(session.id, n, chunk)).statusCode).toBe(200);
    const done = await complete(session.id);
    expect(done.statusCode).toBe(200);
    const result = done.json() as UploadResult;
    expect(result.accepted).toHaveLength(122);
    expect(result.rejected).toHaveLength(275);
    expect(await workingPaths()).toContain("Portfolio/dist/index.html");
    expect((await state(session.id)).statusCode).toBe(404);
  });
});

describe("sessions d'envoi par morceaux", () => {
  async function bigSession() {
    // Trois morceaux : deux pleins et un reste.
    const local: LocalFile[] = [
      { path: "index.html", content: Buffer.from("<!doctype html>") },
      { path: "media/a.bin", content: Buffer.alloc(UPLOAD_CHUNK_BYTES + 5, 3) },
      { path: "media/b.bin", content: Buffer.alloc(UPLOAD_CHUNK_BYTES, 4) },
    ];
    const session = (await open({ kind: "files", dir: "site", files: decl(local) })).json() as UploadSession;
    return { local, session, chunks: streamOf(session, local) };
  }

  it("reprise : l'état dit les morceaux reçus, l'envoi reprend sur les manquants", async () => {
    const { session, chunks } = await bigSession();
    expect(session.chunkCount).toBe(3);
    expect((await put(session.id, 0, chunks[0]!)).statusCode).toBe(200);
    // Coupure : l'interface relit l'état puis n'envoie que ce qui manque.
    const resumed = (await state(session.id)).json() as UploadSession;
    expect(resumed.received).toEqual([0]);
    expect((await complete(session.id)).json().code).toBe("upload_incomplete");
    for (const n of [1, 2]) expect((await put(session.id, n, chunks[n]!)).statusCode).toBe(200);
    const done = await complete(session.id);
    expect(done.statusCode).toBe(200);
    expect((await workingPaths()).sort()).toEqual(["site/index.html", "site/media/a.bin", "site/media/b.bin"]);
    // La liste des sessions ouvertes ne la montre plus.
    expect((await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/uploads`, headers: hub.headers })).json()).toEqual([]);
  });

  it("empreinte fausse : morceau refusé, rien d'enregistré", async () => {
    const { session, chunks } = await bigSession();
    const res = await put(session.id, 0, chunks[0]!, "0".repeat(64));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("chunk_hash_mismatch");
    expect(((await state(session.id)).json() as UploadSession).received).toEqual([]);
    // Taille inattendue : refusée aussi.
    expect((await put(session.id, 0, chunks[0]!.subarray(1))).json().code).toBe("chunk_size_mismatch");
  });

  it("morceau en double : accepté sans effet", async () => {
    const { session, chunks } = await bigSession();
    await put(session.id, 2, chunks[2]!);
    const again = await put(session.id, 2, chunks[2]!);
    expect(again.statusCode).toBe(200);
    expect((again.json() as UploadSession).received).toEqual([2]);
  });

  it("finalisation tout ou rien : un fichier différent de son annonce, rien n'est écrit", async () => {
    const local: LocalFile[] = [
      { path: "index.html", content: Buffer.from("bon") },
      { path: "page.html", content: Buffer.from("changé pendant l'envoi") },
    ];
    const declared = decl(local);
    declared[1]!.sha256 = sha(Buffer.from("contenu annoncé...!!!"));
    const session = (await open({ kind: "files", files: declared })).json() as UploadSession;
    for (const [n, c] of streamOf(session, local).entries()) await put(session.id, n, c);
    const res = await complete(session.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("file_hash_mismatch");
    expect(res.json().error).toMatch(/page\.html/);
    expect(await workingPaths()).toEqual([]);
  });

  it("expiration après 24 h : session refusée puis nettoyée", async () => {
    const { session } = await bigSession();
    const file = path.join(hub.services.dataDir, "uploads", session.id, "session.json");
    const meta = JSON.parse(readFileSync(file, "utf8"));
    meta.expiresAt = new Date(Date.now() - 1000).toISOString();
    writeFileSync(file, JSON.stringify(meta));
    const res = await state(session.id);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("upload_expired");
    expect(existsSync(path.dirname(file))).toBe(false);
  });

  it("annulation : la session et ses morceaux sont supprimés", async () => {
    const { session, chunks } = await bigSession();
    await put(session.id, 0, chunks[0]!);
    const res = await hub.app.inject({ method: "DELETE", url: `/api/sites/${siteId}/uploads/${session.id}`, headers: hub.headers });
    expect(res.statusCode).toBe(200);
    expect((await state(session.id)).statusCode).toBe(404);
    expect(existsSync(path.join(hub.services.dataDir, "uploads", session.id))).toBe(false);
  });

  it("zip piégé passé par morceaux : toujours refusé en entier, version de travail intacte", async () => {
    const zip = patchName(await makeZip([{ name: "index.html", content: "a" }, { name: "XX/evil.txt", content: "b" }]), "XX/evil.txt", "../evil.txt");
    const session = (await open({ kind: "zip", mode: "replace", name: "piege.zip", size: zip.length, sha256: sha(zip) })).json() as UploadSession;
    expect((await put(session.id, 0, zip)).statusCode).toBe(200);
    const res = await complete(session.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^Archive refusée/);
    expect(await workingPaths()).toEqual([]);
  });

  it("zip propre par morceaux : dossier racine retiré, node_modules écarté avec sa raison", async () => {
    const zip = await makeZip([
      { name: "dist/index.html", content: "<!doctype html>" },
      { name: "dist/node_modules/x/index.js", content: "x" },
    ]);
    const session = (await open({ kind: "zip", mode: "merge", name: "site.zip", size: zip.length, sha256: sha(zip) })).json() as UploadSession;
    await put(session.id, 0, zip);
    const result = (await complete(session.id)).json() as UploadResult;
    expect(result.accepted).toEqual(["index.html"]);
    expect(result.strippedRoot).toBe("dist/");
    expect(result.rejected[0]?.reason).toMatch(/node_modules refusé/);
  });
});
