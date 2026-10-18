import { describe, expect, it } from "vitest";
import { checkSitePath, classifySitePath, normalizeDir, normalizeSitePath } from "@/lib/site-paths.js";

const reason = (raw: string) => {
  const r = normalizeSitePath(raw);
  return r.ok ? null : r.reason;
};

describe("normalisation des chemins", () => {
  it("accepte un chemin relatif simple et le normalise en NFC", () => {
    expect(normalizeSitePath("assets/app.css")).toEqual({ ok: true, path: "assets/app.css" });
    const decomposed = "cafe\u0301.html";
    expect(normalizeSitePath(decomposed)).toEqual({ ok: true, path: "caf\u00e9.html" });
  });

  it("refuse « .. » à toute position", () => {
    expect(reason("../secret")).toMatch(/\.\./);
    expect(reason("a/../../b")).toMatch(/\.\./);
    expect(reason("a/..")).toMatch(/\.\./);
  });

  it("refuse les chemins absolus et les lettres de lecteur", () => {
    expect(reason("/etc/passwd")).toMatch(/absolu/);
    expect(reason("C:/Windows/x")).toMatch(/lecteur/);
    expect(reason("c:x")).toMatch(/lecteur/);
  });

  it("refuse l'antislash", () => {
    expect(reason("a\\b.txt")).toMatch(/Antislash/);
    expect(reason("..\\..\\x")).toMatch(/Antislash/);
  });

  it("refuse les caractères de contrôle", () => {
    expect(reason("a\u0000b")).toMatch(/contrôle/);
    expect(reason("a\nb")).toMatch(/contrôle/);
    expect(reason("a\u007fb")).toMatch(/contrôle/);
  });

  it("refuse les segments vides ou « . »", () => {
    expect(reason("a//b")).toMatch(/segment/);
    expect(reason("./a")).toMatch(/segment/);
    expect(reason("a/")).toMatch(/segment/);
    expect(reason("")).toMatch(/vide/);
  });

  it("refuse les noms trop longs et les arborescences trop profondes", () => {
    expect(reason(`${"a".repeat(256)}.html`)).toMatch(/trop long/);
    expect(reason(`${"é".repeat(130)}`)).toMatch(/trop long/);
    expect(reason(Array.from({ length: 33 }, () => "d").join("/"))).toMatch(/profonde/);
    expect(reason(Array.from({ length: 300 }, () => "abcd").join("/"))).toMatch(/trop long|profonde/);
  });

  it("dossier cible : vide pour la racine, « / » final retiré", () => {
    expect(normalizeDir("")).toEqual({ ok: true, path: "" });
    expect(normalizeDir("assets/")).toEqual({ ok: true, path: "assets" });
    expect(normalizeDir("../x").ok).toBe(false);
  });
});

describe("fichiers refusés ou écartés", () => {
  const verdict = (p: string) => classifySitePath(p).action;

  it("refuse le code exécuté par Cloudflare à la racine", () => {
    expect(verdict("_worker.js")).toBe("reject");
    expect(verdict("_routes.json")).toBe("reject");
    expect(verdict("functions/api.js")).toBe("reject");
    expect(verdict("assets/_worker.js")).toBe("accept");
  });

  it("refuse un dossier _worker.js/ ou _routes.json/ à la racine, quelle que soit la casse", () => {
    expect(verdict("_worker.js/index.js")).toBe("reject");
    expect(verdict("_Worker.JS/index.js")).toBe("reject");
    expect(verdict("_WORKER.js")).toBe("reject");
    expect(verdict("_worker.js/lib/util.js")).toBe("reject");
    expect(verdict("_routes.json/x")).toBe("reject");
    expect(verdict("_Routes.JSON")).toBe("reject");
    expect(classifySitePath("_worker.js/index.js")).toEqual({ action: "reject", reason: expect.stringMatching(/_worker\.js refusé/) });
    // Plus bas dans l'arborescence : un fichier ordinaire.
    expect(verdict("docs/_worker.js/index.js")).toBe("accept");
  });

  it("refuse les fichiers de développement et les secrets", () => {
    expect(verdict(".env")).toBe("reject");
    expect(verdict("config/.env.production")).toBe("reject");
    expect(verdict(".git/config")).toBe("reject");
    expect(verdict("node_modules/x/index.js")).toBe("reject");
    expect(verdict("assets/app.js.map")).toBe("reject");
    expect(verdict("index.html.bak")).toBe("reject");
    expect(verdict("index.html~")).toBe("reject");
    expect(verdict(".index.html.swp")).toBe("reject");
  });

  it("écarte sans bruit les fichiers système", () => {
    expect(verdict(".DS_Store")).toBe("ignore");
    expect(verdict("img/Thumbs.db")).toBe("ignore");
    expect(verdict("__MACOSX/._index.html")).toBe("ignore");
  });

  it("accepte _headers, _redirects et un site ordinaire", () => {
    expect(verdict("_headers")).toBe("accept");
    expect(verdict("_redirects")).toBe("accept");
    expect(verdict(".well-known/security.txt")).toBe("accept");
    expect(verdict("index.html")).toBe("accept");
  });

  it("renvoie toujours une raison en français", () => {
    const r = checkSitePath("../x");
    expect(r.verdict).toEqual({ action: "reject", reason: expect.stringMatching(/interdit/) });
  });
});
