import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeTarGz } from "@/lib/tar.js";
import { checkArchiveListing } from "../../../../../scripts/php-ct/agent/sites.mjs";

// Archive d'une version pour l'agent PHP : lue par un vrai tar (bsdtar sous Windows, GNU ou BusyBox ailleurs).
const tarAvailable = (() => {
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(tarAvailable)("archive tar.gz d'une version", () => {
  it("noms courts, longs (plus de 100 octets) et accentués, contenu binaire : relus à l'identique", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kouzia-tar-"));
    const long = `public/${"dossier-tres-long/".repeat(7)}page-éè.php`;
    const binary = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
    const files = [
      { path: "public/index.php", content: Buffer.from("<?php echo 'bonjour';") },
      { path: long, content: Buffer.from("<?php // long") },
      { path: "public/img/logo.png", content: binary },
      { path: "vide.txt", content: Buffer.alloc(0) },
    ];
    expect(Buffer.byteLength(long)).toBeGreaterThan(100);
    const archive = join(dir, "v.tar.gz");
    const { sha256, bytes } = await writeTarGz(
      files.map((f) => ({ path: f.path, size: f.content.length, read: async () => f.content })),
      archive,
    );
    const raw = readFileSync(archive);
    expect(bytes).toBe(raw.length);
    expect(sha256).toBe(createHash("sha256").update(raw).digest("hex"));

    // Nom relatif, lancé dans le dossier : GNU tar lirait « C:... » comme « hôte:chemin ».
    const listing = execFileSync("tar", ["-tvzf", "v.tar.gz"], { encoding: "utf8", cwd: dir });
    expect(checkArchiveListing(listing).sort()).toEqual(files.map((f) => f.path).sort());

    execFileSync("tar", ["-xzf", "v.tar.gz"], { stdio: "ignore", cwd: dir });
    for (const f of files) expect(readFileSync(join(dir, f.path)), f.path).toEqual(f.content);
  });
});
