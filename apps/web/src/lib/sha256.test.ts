import { describe, expect, it } from "vitest";
import { sha256OfFile, WHOLE_FILE_HASH_MAX } from "@/lib/sha256";

// Empreinte des fichiers envoyés : au-delà de 25 Mio, calcul par tranches, même résultat (audit du 27/10/2026).
const reference = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

describe("empreinte d'un fichier envoyé", () => {
  it("petit fichier et gros fichier (par tranches) : même empreinte que SHA-256 d'un coup", async () => {
    const small = new TextEncoder().encode("<h1>Accueil</h1>");
    expect(await sha256OfFile(new Blob([small]))).toBe(await reference(small));
    const big = new Uint8Array(WHOLE_FILE_HASH_MAX + 3 * 1024 * 1024 + 17);
    for (let i = 0; i < big.length; i += 4096) big[i] = i % 251;
    expect(await sha256OfFile(new Blob([big]))).toBe(await reference(big));
  }, 60_000);
});
