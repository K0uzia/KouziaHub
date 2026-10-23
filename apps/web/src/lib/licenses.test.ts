import { describe, expect, it } from "vitest";
import type { LicenseSummary } from "@hub/contract";
import { foldText } from "@/lib/format";
import { matchesLicense, remainingText, sameHolder } from "@/lib/licenses";

const base: LicenseSummary = {
  id: "a",
  entreprise: "Société Ébène",
  erpClientId: null,
  clientName: null,
  emise: "2026-10-22",
  expire: "2027-10-22",
  status: "active",
  notes: null,
  createdAt: "2026-10-22T08:00:00.000Z",
};

describe("clés de licence (interface)", () => {
  it("jours restants : dernier jour, à venir, passé", () => {
    expect(remainingText("2026-10-22", "2026-10-22")).toBe("Expire ce soir");
    expect(remainingText("2026-11-03", "2026-10-22")).toBe("Expire dans 12 jours");
  });

  it("expirée : délai de grâce de 15 jours, puis plus rien", () => {
    expect(remainingText("2026-10-21", "2026-10-22")).toBe("Expirée depuis 1 jour, en grâce jusqu'au 5 novembre 2026");
    expect(remainingText("2026-10-21", "2026-11-05")).toBe("Expirée depuis 15 jours, en grâce jusqu'au 5 novembre 2026");
    expect(remainingText("2026-10-21", "2026-11-06")).toBe("Expirée depuis 16 jours");
    expect(remainingText("2027-02-20", "2027-02-21")).toBe("Expirée depuis 1 jour, en grâce jusqu'au 7 mars 2027");
  });

  it("recherche sans accents ni casse, sur l'entreprise, le client et les notes", () => {
    expect(matchesLicense(base, foldText("ebene"))).toBe(true);
    expect(matchesLicense({ ...base, notes: "Démo salon" }, foldText("DEMO"))).toBe(true);
    expect(matchesLicense(base, foldText("nord"))).toBe(false);
  });

  it("historique : même client de l'ERP ou même entreprise, sans la clé elle-même", () => {
    const all: LicenseSummary[] = [
      base,
      { ...base, id: "b", entreprise: "societe ebene " },
      { ...base, id: "c", entreprise: "Autre nom", erpClientId: "demo-01" },
      { ...base, id: "d", entreprise: "Atelier Nord" },
    ];
    expect(sameHolder(all, base).map((l) => l.id)).toEqual(["b"]);
    expect(sameHolder(all, { ...base, erpClientId: "demo-01" }).map((l) => l.id)).toEqual(["b", "c"]);
  });
});
