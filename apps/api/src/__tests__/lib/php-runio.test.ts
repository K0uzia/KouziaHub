import { describe, expect, it } from "vitest";
import { runIo } from "../../../../../scripts/php-ct/agent/sites.mjs";

// runIo de l'agent PHP, avec de vrais processus (Node lui-même, partout disponible). Un EPIPE non rattrapé sur le
// stdin d'une commande déjà finie arrêtait tout l'agent pendant la publication de my-takumi (26/10/2026) ; vitest
// signale une telle erreur comme un échec du fichier.
const node = process.execPath;

describe("runIo : commandes de l'agent", () => {
  it("commande sortie aussitôt sans lire une grosse entrée : code et stderr rendus, aucun plantage", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await runIo(node, ["-e", "process.exit(3)"], { input: "x".repeat(4 * 1024 * 1024) });
      expect(r.code).toBe(3);
    }
  });

  it("sans entrée : stdin vide (fin de fichier tout de suite), rien n'est écrit dans un tube", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => runIo(node, ["-e", "0"])));
    expect(results.every((r) => r.code === 0)).toBe(true);
    const eof = await runIo(node, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(5))"]);
    expect(eof.code).toBe(5);
  });

  it("entrée lue normalement ; commande introuvable : code 127, sans plantage", async () => {
    const echo = await runIo(node, ["-e", "process.stdin.pipe(process.stdout)"], { input: "bonjour" });
    expect(echo).toMatchObject({ code: 0, stdout: "bonjour" });
    const missing = await runIo("/chemin/introuvable/commande", [], { input: "x" });
    expect(missing.code).toBe(127);
  });
});
