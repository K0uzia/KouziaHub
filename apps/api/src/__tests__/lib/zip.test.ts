import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BlobStore } from "@/lib/blobs.js";
import { extractZip, type ZipLimits } from "@/lib/zip.js";
import { makeZip, patchName, patchUncompressedSize } from "../helpers/hub.js";

const dir = mkdtempSync(join(tmpdir(), "kouzia-hub-zip-"));
const blobs = new BlobStore(dir);
let n = 0;
async function extract(zip: Buffer, limits?: ZipLimits) {
  const file = join(dir, `t${n++}.zip`);
  writeFileSync(file, zip);
  return extractZip(file, blobs, limits);
}

const MIB = 1024 * 1024;

describe("lecture des zips", () => {
  it("accepte un site ordinaire et range les fichiers dans le magasin d'objets", async () => {
    const r = await extract(await makeZip([{ name: "index.html", content: "<h1>ok</h1>" }, { name: "css/a.css", content: "a{}" }]));
    expect(r.accepted.map((f) => f.path).sort()).toEqual(["css/a.css", "index.html"]);
    expect(r.rejected).toEqual([]);
    expect((await blobs.read(r.accepted.find((f) => f.path === "index.html")!.sha256)).toString()).toBe("<h1>ok</h1>");
  });

  it("retire le dossier racine unique s'il n'y a pas d'index.html à la racine", async () => {
    const r = await extract(
      await makeZip([
        { name: "dist/index.html", content: "x" },
        { name: "dist/_worker.js", content: "evil" },
        { name: "__MACOSX/dist/._index.html", content: "meta" },
      ]),
    );
    expect(r.strippedRoot).toBe("dist/");
    expect(r.accepted.map((f) => f.path)).toEqual(["index.html"]);
    // Après retrait du dossier racine, _worker.js est à la racine : refusé.
    expect(r.rejected.find((x) => x.path === "_worker.js")?.reason).toMatch(/hub injecte/);
    expect(r.rejected.find((x) => x.path.startsWith("__MACOSX"))?.reason).toMatch(/système/);
  });

  it("ne retire rien si index.html est déjà à la racine", async () => {
    const r = await extract(await makeZip([{ name: "index.html", content: "x" }]));
    expect(r.strippedRoot).toBeNull();
  });

  it("refuse les liens symboliques (attributs Unix)", async () => {
    const r = await extract(
      await makeZip([
        { name: "index.html", content: "x" },
        { name: "lien", content: "/etc/passwd", mode: 0o120777 },
      ]),
    );
    expect(r.accepted.map((f) => f.path)).toEqual(["index.html"]);
    expect(r.rejected).toEqual([{ path: "lien", reason: "Lien symbolique refusé." }]);
  });

  it("refuse l'archive entière si un nom contient « .. »", async () => {
    const zip = patchName(await makeZip([{ name: "XX/evil.txt", content: "pwn" }]), "XX/evil.txt", "../evil.txt");
    await expect(extract(zip)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Archive refusée.*\.\./) });
  });

  it("refuse l'archive entière pour un chemin absolu ou un antislash", async () => {
    const absolute = patchName(await makeZip([{ name: "Xetc/passwd", content: "pwn" }]), "Xetc/passwd", "/etc/passwd");
    await expect(extract(absolute)).rejects.toMatchObject({ statusCode: 400 });
    const backslash = patchName(await makeZip([{ name: "a_b.txt", content: "pwn" }]), "a_b.txt", "a\\b.txt");
    await expect(extract(backslash)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuse l'archive entière si deux noms ne diffèrent que par la casse", async () => {
    const zip = await makeZip([
      { name: "index.html", content: "1" },
      { name: "INDEX.html", content: "2" },
    ]);
    await expect(extract(zip)).rejects.toMatchObject({ message: expect.stringMatching(/même nom/) });
  });

  it("refuse l'archive entière pour un nom en double exact", async () => {
    const zip = patchName(
      await makeZip([
        { name: "index.html", content: "1" },
        { name: "indey.html", content: "2" },
      ]),
      "indey.html",
      "index.html",
    );
    await expect(extract(zip)).rejects.toMatchObject({ message: expect.stringMatching(/même nom/) });
  });

  it("refuse les fichiers interdits avec une raison et écarte les fichiers système", async () => {
    const r = await extract(
      await makeZip([
        { name: "index.html", content: "x" },
        { name: ".env", content: "SECRET=1" },
        { name: ".git/HEAD", content: "ref" },
        { name: "node_modules/a/index.js", content: "x" },
        { name: "app.js.map", content: "{}" },
        { name: "old.bak", content: "x" },
        { name: "functions/api.js", content: "x" },
        { name: "_routes.json", content: "{}" },
        { name: ".DS_Store", content: "x" },
        { name: "_headers", content: "/*\n  X-Test: 1" },
      ]),
    );
    expect(r.accepted.map((f) => f.path).sort()).toEqual(["_headers", "index.html"]);
    expect(r.rejected).toHaveLength(8);
    for (const x of r.rejected) expect(x.reason.length).toBeGreaterThan(5);
  });

  it("refuse un fichier annoncé au-delà du plafond par fichier", async () => {
    const r = await extract(
      await makeZip([
        { name: "index.html", content: "x" },
        { name: "big.bin", content: Buffer.alloc(2 * MIB) },
      ]),
      { maxFiles: 100, maxFileBytes: MIB, maxTotalBytes: 10 * MIB },
    );
    expect(r.rejected).toEqual([{ path: "big.bin", reason: expect.stringMatching(/Mio/) }]);
  });

  it("bombe zip : la taille réellement décompressée compte, pas l'en-tête", async () => {
    // 3 Mio de zéros annoncés à 100 octets : refusé à la lecture, rien n'est accepté.
    const zip = patchUncompressedSize(await makeZip([{ name: "index.html", content: Buffer.alloc(3 * MIB) }]), 100);
    await expect(extract(zip, { maxFiles: 100, maxFileBytes: MIB, maxTotalBytes: 10 * MIB })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/Archive refusée/),
    });
  });

  it("refuse l'archive au-delà du plafond de taille décompressée totale", async () => {
    const zip = await makeZip([
      { name: "index.html", content: Buffer.alloc(900 * 1024, 1) },
      { name: "b.bin", content: Buffer.alloc(900 * 1024, 2) },
    ]);
    await expect(extract(zip, { maxFiles: 100, maxFileBytes: MIB, maxTotalBytes: 1.5 * MIB })).rejects.toMatchObject({
      message: expect.stringMatching(/totale/),
    });
  });

  it("refuse l'archive au-delà du nombre de fichiers", async () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.txt`, content: String(i) }));
    await expect(extract(await makeZip(entries), { maxFiles: 5, maxFileBytes: MIB, maxTotalBytes: MIB })).rejects.toMatchObject({
      message: expect.stringMatching(/plus de 5/),
    });
  });

  it("refuse un fichier qui n'est pas un zip", async () => {
    await expect(extract(Buffer.from("pas un zip"))).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/illisible/) });
  });
});
