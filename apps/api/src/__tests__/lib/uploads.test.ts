import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BlobStore } from "@/lib/blobs.js";
import { HttpError } from "@/lib/http.js";
import { MAX_UPLOAD_SESSIONS, MAX_UPLOAD_SESSIONS_PER_SITE } from "@/lib/limits.js";
import { UploadStore } from "@/lib/uploads.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const tmp = () => mkdtempSync(path.join(tmpdir(), "kouzia-hub-uploads-"));
const plenty = async () => 100 * GIB;

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err instanceof HttpError ? `${err.statusCode} ${err.code}` : String(err);
  }
}

const zip = (size: number) => ({ kind: "zip" as const, mode: "merge" as const, name: "site.zip", size, sha256: "a".repeat(64) });

describe("plafonds des sessions d'envoi", () => {
  it("3 sessions ouvertes par site, 10 au total", async () => {
    const store = new UploadStore(tmp(), Date.now, plenty);
    for (let i = 0; i < MAX_UPLOAD_SESSIONS_PER_SITE; i++) await store.create("site-a", zip(10));
    expect(await code(store.create("site-a", zip(10)))).toBe("409 too_many_uploads");
    // Autres sites : le total plafonne à 10.
    let opened = MAX_UPLOAD_SESSIONS_PER_SITE;
    for (let s = 0; opened < MAX_UPLOAD_SESSIONS; s++) {
      for (let i = 0; i < MAX_UPLOAD_SESSIONS_PER_SITE && opened < MAX_UPLOAD_SESSIONS; i++, opened++) await store.create(`site-${s}`, zip(10));
    }
    expect(await code(store.create("site-z", zip(10)))).toBe("409 too_many_uploads");
  });

  it("octets en attente plafonnés au total", async () => {
    const store = new UploadStore(tmp(), Date.now, plenty);
    await store.create("a", zip(500 * MIB));
    await store.create("b", zip(500 * MIB));
    expect(await code(store.create("c", zip(30 * MIB)))).toBe("413 upload_quota");
  });

  it("place disque insuffisante : 507 disk_full à l'ouverture et à chaque morceau", async () => {
    let free = 100 * MIB;
    const store = new UploadStore(tmp(), Date.now, async () => free);
    const err = await store.create("a", zip(10)).catch((e: HttpError) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(507);
    expect((err as HttpError).code).toBe("disk_full");
    expect((err as HttpError).message).toMatch(/Place disque insuffisante.*il reste 100,0 Mio/);
    free = 10 * GIB;
    const data = Buffer.from("contenu du zip");
    const session = await store.create("a", { ...zip(data.length), sha256: sha(data) });
    free = 512 * MIB;
    expect(await code(store.putChunk("a", session.id, 0, data, sha(data)))).toBe("507 disk_full");
    free = 10 * GIB;
    expect((await store.putChunk("a", session.id, 0, data, sha(data))).received).toEqual([0]);
  });
});

describe("assemblage sans doubler la place prise", () => {
  it("zip : chaque morceau est supprimé dès qu'il est copié", async () => {
    const dir = tmp();
    const store = new UploadStore(dir, Date.now, plenty);
    const data = Buffer.from("PK zip factice");
    const session = await store.create("a", { ...zip(data.length), sha256: sha(data) });
    await store.putChunk("a", session.id, 0, data, sha(data));
    const { zipPath, done } = await store.assemble("a", session.id, new BlobStore(dir));
    expect(zipPath).not.toBeNull();
    expect(readdirSync(path.join(dir, "uploads", session.id, "chunks"))).toEqual([]);
    await done();
  });

  it("fichiers : morceaux supprimés une fois copiés dans le magasin", async () => {
    const dir = tmp();
    const store = new UploadStore(dir, Date.now, plenty);
    const a = Buffer.from("<!doctype html>");
    const b = Buffer.from("body{}");
    const session = await store.create("a", {
      kind: "files",
      files: [
        { path: "index.html", size: a.length, sha256: sha(a) },
        { path: "a.css", size: b.length, sha256: sha(b) },
      ],
    });
    const stream = Buffer.concat([a, b]);
    await store.putChunk("a", session.id, 0, stream, sha(stream));
    const { stored, done } = await store.assemble("a", session.id, new BlobStore(dir));
    expect(stored.map((f) => f.path)).toEqual(["index.html", "a.css"]);
    expect(readdirSync(path.join(dir, "uploads", session.id, "chunks"))).toEqual([]);
    await done();
  });
});
