import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addMonths, canonicalJson, expiryOf, licenseStatus, normalizeEntreprise, parisToday, signTb1, verifyTb1, type Tb1Payload } from "@/lib/licenses/tb1.js";

// Paire générée dans le test : aucun vecteur ne dépend de la clé de production (docs/licences-logiciels.md, section 8).
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const payload = (over: Partial<Tb1Payload> = {}): Tb1Payload => ({ v: 1, id: "clxyz", entreprise: "Atelier Nord", emise: "2026-10-22", expire: "2027-10-22", ...over });

describe("format TB1 (contrat normatif)", () => {
  it("JSON canonique : clés dans l'ordre, accents laissés tels quels, guillemets échappés par JSON.stringify", () => {
    expect(canonicalJson(payload())).toBe('{"v":1,"id":"clxyz","entreprise":"Atelier Nord","emise":"2026-10-22","expire":"2027-10-22"}');
    expect(canonicalJson(payload({ entreprise: 'Société "Ébène"' }))).toBe('{"v":1,"id":"clxyz","entreprise":"Société \\"Ébène\\"","emise":"2026-10-22","expire":"2027-10-22"}');
  });

  it("signe les octets UTF-8 du JSON, vérifie avec la publique ; base64url sans padding", () => {
    const key = signTb1(payload({ entreprise: 'Société "Ébène"' }), privateKey);
    const [prefix, data, sig] = key.split(".");
    expect(prefix).toBe("TB1");
    expect(data).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(data!, "base64url").toString("utf8")).toContain("Société");
    expect(verifyTb1(key, publicKey)).toEqual({ ok: true, payload: payload({ entreprise: 'Société "Ébène"' }) });
  });

  it("signature fausse, JSON modifié, v différent, segments ou base64 incorrects : refusés", () => {
    const key = signTb1(payload(), privateKey);
    const [p, data, sig] = key.split(".") as [string, string, string];
    expect(verifyTb1(key, other.publicKey)).toEqual({ ok: false, reason: "signature" });
    const forged = Buffer.from(canonicalJson(payload({ entreprise: "Autre" })), "utf8").toString("base64url");
    expect(verifyTb1(`${p}.${forged}.${sig}`, publicKey)).toEqual({ ok: false, reason: "signature" });
    const v2 = Buffer.from(JSON.stringify({ ...payload(), v: 2 }), "utf8").toString("base64url");
    expect(verifyTb1(`${p}.${v2}.${sig}`, publicKey)).toEqual({ ok: false, reason: "format" });
    expect(verifyTb1(`${key}.x`, publicKey)).toEqual({ ok: false, reason: "format" });
    expect(verifyTb1(`TB2.${data}.${sig}`, publicKey)).toEqual({ ok: false, reason: "format" });
    expect(verifyTb1(`TB1.${data}=.${sig}`, publicKey)).toEqual({ ok: false, reason: "format" });
    // JSON valide mais non canonique (espace) : refusé, les octets signés seraient ambigus.
    const spaced = Buffer.from(JSON.stringify(payload(), null, 1), "utf8").toString("base64url");
    expect(verifyTb1(`${p}.${spaced}.${sig}`, publicKey)).toEqual({ ok: false, reason: "format" });
  });
});

describe("nom d'entreprise et dates (sections 3.4 et 3.5)", () => {
  it("nom : bords retirés, NFC, 1 à 120 caractères, sans caractère de contrôle", () => {
    expect(normalizeEntreprise("  Atelier Nord  ")).toEqual({ ok: true, value: "Atelier Nord" });
    expect(normalizeEntreprise("Société")).toEqual({ ok: true, value: "Société" });
    expect(normalizeEntreprise("   ").ok).toBe(false);
    expect(normalizeEntreprise("x".repeat(121)).ok).toBe(false);
    expect(normalizeEntreprise("é".repeat(120)).ok).toBe(true);
    expect(normalizeEntreprise("Atelier\u0007Nord").ok).toBe(false);
  });

  it("ajout de mois : même quantième, sinon dernier jour du mois d'arrivée", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-10-22", 12)).toBe("2027-10-22");
    expect(addMonths("2026-11-30", 3)).toBe("2027-02-28");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
  });

  it("durée : mois de 1 à 36 ou date libre entre l'émission et dix ans, exactement l'un des deux", () => {
    expect(expiryOf("2026-10-22", { months: 12 })).toEqual({ ok: true, value: "2027-10-22" });
    expect(expiryOf("2026-10-22", { expire: "2026-10-22" })).toEqual({ ok: true, value: "2026-10-22" });
    expect(expiryOf("2026-10-22", { expire: "2036-10-22" })).toEqual({ ok: true, value: "2036-10-22" });
    for (const bad of [{}, { months: 12, expire: "2027-01-01" }, { months: 0 }, { months: 37 }, { months: 1.5 }, { expire: "2026-10-21" }, { expire: "2036-10-23" }, { expire: "2027-02-30" }]) {
      expect(expiryOf("2026-10-22", bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("état : valable le jour d'expiration, expirée le lendemain ; bientôt expirée à 30 jours ou moins", () => {
    expect(licenseStatus("2027-10-22", "2027-10-22")).toBe("expiring");
    expect(licenseStatus("2027-10-22", "2027-10-23")).toBe("expired");
    expect(licenseStatus("2027-10-22", "2027-09-23")).toBe("expiring");
    expect(licenseStatus("2027-10-22", "2027-09-22")).toBe("active");
  });

  it("jour d'émission : calendrier de Paris (23 h 30 UTC le 31 décembre = 1er janvier à Paris)", () => {
    expect(parisToday(Date.UTC(2026, 11, 31, 23, 30))).toBe("2027-01-01");
  });
});
