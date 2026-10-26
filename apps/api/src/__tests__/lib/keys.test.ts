import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consumeRecoveryCode, hashRecoveryCode, legacyRecoveryHash, regenerateRecoveryCodes } from "@/lib/admin/two-factor.js";
import { decrypt, encrypt, encryptionKey, subKey } from "@/lib/crypto.js";
import { assertSecurityEnv } from "@/lib/env.js";
import { createAdmin } from "../helpers/auth.js";
import { prisma, resetDb } from "../helpers/db.js";

// Clé de chiffrement (revue de sécurité commune avec l'ERP) : hexadécimal strict partout, sous-clé dédiée aux codes
// de secours, ancien format accepté puis réécrit.
const KEY = process.env.ENCRYPTION_KEY!;
afterEach(() => {
  process.env.ENCRYPTION_KEY = KEY;
});

describe("ENCRYPTION_KEY : hexadécimal strict", () => {
  it("64 caractères dont un non hexadécimal : refusée au démarrage, au chiffrement et au déchiffrement (mot de passe SMTP)", () => {
    const sealed = encrypt("mot-de-passe-smtp");
    // Buffer.from(…, "hex") s'arrêterait en silence au « g » : clé tronquée, sans erreur.
    process.env.ENCRYPTION_KEY = `${KEY.slice(0, 40)}g${KEY.slice(41)}`;
    expect(process.env.ENCRYPTION_KEY).toHaveLength(64);
    expect(() => assertSecurityEnv()).toThrow(/64 caractères hexadécimaux/);
    expect(() => encryptionKey()).toThrow(/64 caractères hexadécimaux/);
    expect(() => encrypt("x")).toThrow(/64 caractères hexadécimaux/);
    expect(() => decrypt(sealed)).toThrow(/64 caractères hexadécimaux/);
    process.env.ENCRYPTION_KEY = KEY;
    expect(decrypt(sealed)).toBe("mot-de-passe-smtp");
  });

  it("sous-clé dédiée : différente de la clé et d'un usage à l'autre", () => {
    expect(subKey("codes-de-secours")).toHaveLength(32);
    expect(subKey("codes-de-secours").equals(encryptionKey())).toBe(false);
    expect(subKey("codes-de-secours").equals(subKey("autre"))).toBe(false);
  });
});

describe("codes de secours 2FA : sous-clé HKDF, ancien format compatible", () => {
  let userId: string;
  beforeEach(async () => {
    await resetDb();
    userId = (await createAdmin()).id;
  });

  it("nouveaux codes : empreinte par la sous-clé, jamais par la clé de chiffrement ; un seul usage", async () => {
    const [code] = await regenerateRecoveryCodes(userId);
    const stored = await prisma.adminRecoveryCode.findMany({ where: { userId } });
    expect(stored.map((s) => s.codeHash)).toContain(hashRecoveryCode(code!));
    expect(stored.map((s) => s.codeHash)).not.toContain(createHmac("sha256", encryptionKey()).update(code!.replace("-", "")).digest("hex"));
    expect(await consumeRecoveryCode(userId, code!)).toBe(true);
    expect(await consumeRecoveryCode(userId, code!)).toBe(false);
  });

  it("code de l'ancien format : accepté une fois, réécrit au nouveau format en même temps", async () => {
    const code = "ABCDE-FGHJK";
    await prisma.adminRecoveryCode.create({ data: { userId, codeHash: legacyRecoveryHash(code) } });
    expect(await consumeRecoveryCode(userId, code)).toBe(true);
    const row = await prisma.adminRecoveryCode.findFirstOrThrow({ where: { userId } });
    expect(row.codeHash).toBe(hashRecoveryCode(code));
    expect(row.usedAt).not.toBeNull();
    expect(await consumeRecoveryCode(userId, code)).toBe(false);
  });
});
