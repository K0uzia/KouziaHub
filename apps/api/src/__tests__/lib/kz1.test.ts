import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalKz1, signKz1, verifyKz1, type Kz1Payload } from "@/lib/licenses/kz1.js";

// Format générique (docs/licences-logiciels.md, section 3.7). Paire générée dans le test.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const payload = (over: Partial<Kz1Payload> = {}): Kz1Payload => ({ v: 1, logiciel: "atelier", id: "clxyz", entreprise: "Atelier Nord", emise: "2026-10-23", expire: "2027-10-23", ...over });
const expected = { prefix: "ATL1", logiciel: "atelier" };

describe("format KZ1 (contrat normatif)", () => {
  it("JSON canonique : v, logiciel, id, entreprise, emise, expire, dans cet ordre", () => {
    expect(canonicalKz1(payload({ entreprise: 'Société "Ébène"' }))).toBe(
      '{"v":1,"logiciel":"atelier","id":"clxyz","entreprise":"Société \\"Ébène\\"","emise":"2026-10-23","expire":"2027-10-23"}',
    );
  });

  it("préfixe du logiciel, base64url sans padding, vérifiable", () => {
    const key = signKz1("ATL1", payload(), privateKey);
    const [prefix, data, sig] = key.split(".");
    expect(prefix).toBe("ATL1");
    expect(`${data}${sig}`).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifyKz1(key, expected, publicKey)).toEqual({ ok: true, payload: payload() });
  });

  it("refus : autre logiciel attendu, autre préfixe, JSON réordonné, signature d'une autre paire", () => {
    const key = signKz1("ATL1", payload(), privateKey);
    expect(verifyKz1(key, { prefix: "ATL1", logiciel: "tracebay" }, publicKey)).toEqual({ ok: false, reason: "logiciel" });
    expect(verifyKz1(key, { prefix: "TB1", logiciel: "atelier" }, publicKey)).toEqual({ ok: false, reason: "format" });
    expect(verifyKz1(key, expected, generateKeyPairSync("ed25519").publicKey)).toEqual({ ok: false, reason: "signature" });
    const [, , sig] = key.split(".") as [string, string, string];
    const reordered = Buffer.from(JSON.stringify({ logiciel: "atelier", v: 1, id: "clxyz", entreprise: "Atelier Nord", emise: "2026-10-23", expire: "2027-10-23" })).toString("base64url");
    expect(verifyKz1(`ATL1.${reordered}.${sig}`, expected, publicKey)).toEqual({ ok: false, reason: "format" });
    // Champ « logiciel » d'une clé signée pour un autre logiciel avec la même paire : refusé.
    const other = signKz1("ATL1", payload({ logiciel: "autre" }), privateKey);
    expect(verifyKz1(other, expected, publicKey)).toEqual({ ok: false, reason: "logiciel" });
  });
});
