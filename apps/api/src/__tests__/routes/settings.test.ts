import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkReportField, type ReportSettings } from "@/contract.js";
import { prisma, resetDb } from "../helpers/db.js";
import { buildTestHub, type TestHub } from "../helpers/hub.js";

let hub: TestHub;

beforeEach(async () => {
  await resetDb();
  hub = await buildTestHub();
});
afterEach(async () => {
  await hub.app.close();
});

const patch = (payload: unknown) => hub.app.inject({ method: "PATCH", url: "/api/settings/reports", headers: hub.headers, payload: payload as object });

describe("réglages « Rapports »", () => {
  it("vide au départ, enregistre des valeurs normalisées, chaîne vide efface", async () => {
    const empty = await hub.app.inject({ method: "GET", url: "/api/settings/reports", headers: hub.headers });
    expect(empty.json()).toEqual({ displayName: null, email: null, phone: null, website: null });

    const saved = await patch({ displayName: "  Atelier Exemple ", email: "Contact@Exemple.FR", phone: "+33 6.12-34 56 78", website: "https://www.exemple.fr/" });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ displayName: "Atelier Exemple", email: "contact@exemple.fr", phone: "0612345678", website: "https://www.exemple.fr" });
    expect(await prisma.auditEvent.count({ where: { action: "settings.reports" } })).toBe(1);

    const cleared = await patch({ phone: "", website: null });
    expect(cleared.json()).toEqual({ displayName: "Atelier Exemple", email: "contact@exemple.fr", phone: null, website: null });
    expect(await prisma.hubSetting.count({ where: { key: { startsWith: "report." } } })).toBe(2);
  });

  it("valeur refusée : 400 rattaché au champ, rien d'enregistré", async () => {
    for (const [field, value] of [
      ["email", "pas-une-adresse"],
      ["phone", "12345"],
      ["website", "http://www.exemple.fr"],
      ["displayName", "x".repeat(81)],
    ] as const) {
      const res = await patch({ displayName: "Gardé ?", [field]: value });
      expect(res.statusCode, `${field}=${value}`).toBe(400);
      expect(res.json()).toMatchObject({ code: "invalid_field", field });
    }
    expect(await prisma.hubSetting.count({ where: { key: { startsWith: "report." } } })).toBe(0);
    const unknown = await patch({ adresse: "1 rue Exemple" });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().field).toBeUndefined();
  });
});

describe("contrôle des champs (partagé avec le formulaire)", () => {
  const ok = (field: keyof ReportSettings, raw: string) => {
    const r = checkReportField(field, raw);
    return r.ok ? r.value : `refusé : ${r.error}`;
  };

  it("téléphone au format français", () => {
    expect(ok("phone", "06 12 34 56 78")).toBe("0612345678");
    expect(ok("phone", "01.23.45.67.89")).toBe("0123456789");
    expect(ok("phone", "09-87-65-43-21")).toBe("0987654321");
    expect(ok("phone", "+33612345678")).toBe("0612345678");
    expect(ok("phone", "+33 1 23 45 67 89")).toBe("0123456789");
    for (const bad of ["0012345678", "061234567", "06123456789", "+330612345678", "+3361234567", "+44 20 7946 0000", "06 12 34 56 7a", "(06) 12 34 56 78"]) {
      expect(ok("phone", bad), bad).toMatch(/^refusé/);
    }
  });

  it("e-mail valide, site en https:// seulement, nom de 1 à 80 caractères, vide efface", () => {
    expect(ok("email", "nom.prenom+rapport@sous.domaine.fr")).toBe("nom.prenom+rapport@sous.domaine.fr");
    for (const bad of ["nom@domaine", "@domaine.fr", "nom domaine@x.fr", "nom@@x.fr"]) expect(ok("email", bad), bad).toMatch(/^refusé/);
    expect(ok("website", "https://Exemple.fr/contact")).toBe("https://exemple.fr/contact");
    for (const bad of ["www.exemple.fr", "http://exemple.fr", "https://localhost", "https://user:pass@exemple.fr", "ftp://exemple.fr"]) {
      expect(ok("website", bad), bad).toMatch(/^refusé/);
    }
    expect(ok("displayName", "x".repeat(80))).toHaveLength(80);
    expect(ok("displayName", "x".repeat(81))).toMatch(/^refusé/);
    expect(ok("displayName", "a\u0007b")).toMatch(/^refusé/);
    expect(checkReportField("email", "   ")).toEqual({ ok: true, value: null });
  });
});
