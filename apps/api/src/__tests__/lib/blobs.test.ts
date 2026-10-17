import { existsSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { BlobStore } from "@/lib/blobs.js";
import { resetDb } from "../helpers/db.js";

const store = () => new BlobStore(mkdtempSync(join(tmpdir(), "kouzia-hub-blobs-")));
const age = (blobs: BlobStore, sha: string) => {
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(blobs.pathOf(sha), old, old);
};

beforeEach(async () => {
  await resetDb();
});

describe("magasin d'objets", () => {
  it("gc() efface un blob ancien sans référence", async () => {
    const blobs = store();
    const { sha256 } = await blobs.putBuffer(Buffer.from("orphelin"));
    age(blobs, sha256);
    expect(await blobs.gc()).toBe(1);
    expect(existsSync(blobs.pathOf(sha256))).toBe(false);
  });

  it("un blob ancien réemployé par un nouvel envoi (tampon) n'est pas effacé avant l'écriture de ses lignes", async () => {
    const blobs = store();
    const { sha256 } = await blobs.putBuffer(Buffer.from("partagé"));
    age(blobs, sha256);
    await blobs.putBuffer(Buffer.from("partagé"));
    expect(await blobs.gc()).toBe(0);
    expect(existsSync(blobs.pathOf(sha256))).toBe(true);
  });

  it("idem pour un envoi en flux", async () => {
    const blobs = store();
    const { sha256 } = await blobs.putBuffer(Buffer.from("flux"));
    age(blobs, sha256);
    await blobs.putStream(Readable.from([Buffer.from("flux")]), 100);
    expect(await blobs.gc()).toBe(0);
    expect(existsSync(blobs.pathOf(sha256))).toBe(true);
  });
});
