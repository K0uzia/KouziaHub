import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { realSys } from "../../../../../scripts/php-ct/agent/sites.mjs";

// Reprise des dossiers persistants par descripteurs (revue de l'agent, 27/10/2026) : vraie implémentation, sur Linux
// seulement (/proc/self/fd). Chaque niveau est ouvert sans suivre de lien : un parent remplacé par un lien est refusé.
const linux = process.platform === "linux" && existsSync("/proc/self/fd");

describe.runIf(linux)("claimDirs (Linux)", () => {
  const sys = realSys(async () => ({ code: 0, stdout: "", stderr: "" }));
  const ids = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

  it("dossiers parcourus ; absent : arrêt sans erreur ; lien ou fichier : refusés, rien au-delà", async () => {
    const base = mkdtempSync(join(tmpdir(), "kouzia-claim-"));
    mkdirSync(join(base, "public/assets"), { recursive: true });
    expect(await sys.claimDirs(base, ["public", "assets"], ids, 0o750)).toEqual({ refused: null });
    expect(await sys.claimDirs(base, ["public", "absent", "x"], ids, 0o750)).toEqual({ refused: null });

    const outside = mkdtempSync(join(tmpdir(), "kouzia-ailleurs-"));
    mkdirSync(join(outside, "cible"));
    symlinkSync(outside, join(base, "public/lien"));
    expect(await sys.claimDirs(base, ["public", "lien", "cible"], ids, 0o750)).toEqual({ refused: { kind: "link", path: join(base, "public/lien") } });

    writeFileSync(join(base, "public/fichier"), "x");
    expect(await sys.claimDirs(base, ["public", "fichier"], ids, 0o750)).toEqual({ refused: { kind: "notdir", path: join(base, "public/fichier") } });
  });
});
