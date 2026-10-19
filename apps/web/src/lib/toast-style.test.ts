import { describe, expect, it } from "vitest";
import { pushTarget, pushToastKind } from "@/lib/push";

// Sources de l'interface, lues comme texte par Vite (hors tests).
const SOURCES = import.meta.glob(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("toasts au style de l'ERP", () => {
  it("un seul Toaster (AppToaster), ni richColors, ni toast() ni toast.message sans pastille", () => {
    const offenders: string[] = [];
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20);
    for (const [rel, text] of Object.entries(SOURCES)) {
      // AppToaster décrit la règle dans son commentaire.
      if (rel.endsWith("/ui/AppToaster.tsx")) continue;
      if (/richColors/.test(text)) offenders.push(`${rel} : richColors`);
      if (/\btoast\s*\(|\btoast\.message\s*\(|\btoast\.custom\s*\(/.test(text)) offenders.push(`${rel} : toast sans pastille`);
      if (/<Toaster\b|from "sonner";[\s\S]*\bToaster\b/.test(text)) offenders.push(`${rel} : Toaster hors AppToaster`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("notification reçue hub à l'écran", () => {
  it("pastille d'après le titre : panne en erreur, retour en réussite, test en information, le reste en avertissement", () => {
    expect(pushToastKind({ title: "Panne : Boulangerie", tag: "incident:1" })).toBe("error");
    expect(pushToastKind({ title: "Site en panne : Boulangerie", tag: "incident-1" })).toBe("error");
    expect(pushToastKind({ title: "3 sites en panne" })).toBe("error");
    expect(pushToastKind({ title: "3 sites toujours en panne" })).toBe("error");
    expect(pushToastKind({ title: "Toujours en panne : Boulangerie" })).toBe("error");
    expect(pushToastKind({ title: "Hub hors ligne", tag: "hub-hors-ligne" })).toBe("error");
    expect(pushToastKind({ title: "Rétabli : Boulangerie" })).toBe("success");
    expect(pushToastKind({ title: "Site rétabli : Boulangerie", tag: "incident-1" })).toBe("success");
    expect(pushToastKind({ title: "4 sites rétablis" })).toBe("success");
    expect(pushToastKind({ title: "Hub de nouveau en ligne", tag: "hub-hors-ligne" })).toBe("success");
    expect(pushToastKind({ title: "Notification de test", tag: "test:1" })).toBe("info");
    expect(pushToastKind({ title: "Le certificat expire dans 7 jours" })).toBe("warning");
  });

  it("écran ouvert : chemin du hub seulement", () => {
    expect(pushTarget("/surveillance/abc")).toBe("/surveillance/abc");
    expect(pushTarget("//evil.example/x")).toBe("/surveillance");
    expect(pushTarget("https://evil.example/")).toBe("/surveillance");
  });
});
