import { describe, expect, it } from "vitest";
import { checkSoftwareField, type SoftwareSummary } from "@hub/contract";
import { foldText } from "@/lib/format";
import { matchesSoftware, matchesSoftwareFilter, prefixFrom, softwareSlugFrom } from "@/lib/software";

const base: SoftwareSummary = {
  slug: "atelier",
  name: "Atelier Pro",
  format: "KZ1",
  keyPrefix: "ATL1",
  description: "Gestion d'atelier",
  demoUrl: null,
  releasesUrl: null,
  thumbnailUrl: null,
  thumbnailFit: null,
  thumbnailColor: null,
  signing: true,
  counts: { active: 2, expiring: 1, expired: 0 },
  nextExpiry: { expire: "2026-11-01", entreprise: "Atelier Nord" },
};

describe("logiciels (interface)", () => {
  it("identifiant et préfixe proposés depuis le nom ; TB1 et KZ1 jamais proposés", () => {
    expect(softwareSlugFrom("Éditeur & Cie")).toBe("editeur-et-cie");
    expect(prefixFrom("atelier")).toBe("ATE1");
    expect(prefixFrom("tb")).toBe("TB2");
    expect(prefixFrom("kz-outil")).toBe("KZO1");
    expect(prefixFrom("")).toBe("");
  });

  it("règles partagées avec l'API : identifiant, préfixe réservé, adresse https", () => {
    expect(checkSoftwareField("slug", "atelier-pro")).toEqual({ ok: true, value: "atelier-pro" });
    expect(checkSoftwareField("slug", "a--b").ok).toBe(false);
    expect(checkSoftwareField("keyPrefix", "TB1").ok).toBe(false);
    expect(checkSoftwareField("demoUrl", "http://x.fr").ok).toBe(false);
    expect(checkSoftwareField("demoUrl", "")).toEqual({ ok: true, value: null });
  });

  it("filtres et recherche sans accents", () => {
    expect(matchesSoftwareFilter(base, "renew")).toBe(true);
    expect(matchesSoftwareFilter(base, "nokey")).toBe(false);
    expect(matchesSoftwareFilter({ ...base, signing: false }, "nokey")).toBe(true);
    expect(matchesSoftware(base, foldText("ATL1"))).toBe(true);
    expect(matchesSoftware(base, foldText("gestion d'ATELIER"))).toBe(true);
    expect(matchesSoftware(base, foldText("tracebay"))).toBe(false);
  });
});
