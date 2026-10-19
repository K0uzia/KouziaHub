import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkVersion } from "@/lib/version-check.js";

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "site", scripts });

describe("contrôle de la version : projets non construits", () => {
  it("Astro : sources sans dist, commande et dossier annoncés (script build lu dans package.json)", () => {
    const check = checkVersion(["package.json", "astro.config.mjs", "src/pages/index.astro", "public/favicon.svg"], pkg({ build: "astro build" }));
    expect(check).toEqual({
      code: "unbuilt",
      framework: "Astro",
      command: "npm run build",
      outDir: "dist/",
      buildScript: "astro build",
      message: "Projet Astro non construit : lancez npm run build sur votre PC, puis envoyez le dossier dist/.",
    });
  });

  it("Astro : dist envoyé à la racine (construit) passe ; projet entier avec dist/ : envoyer seulement dist/", () => {
    expect(checkVersion(["index.html", "_astro/index.B1x2.css", "favicon.svg", "404.html"], null)).toBeNull();
    const nested = checkVersion(["package.json", "astro.config.mjs", "src/pages/index.astro", "dist/index.html", "dist/_astro/a.css"], pkg({ build: "astro build" }));
    expect(nested).toMatchObject({ code: "output_folder", framework: "Astro", outDir: "dist/" });
    expect(nested!.message).toBe("Projet Astro envoyé en entier : le site construit est dans dist/. Envoyez seulement le contenu du dossier dist/ (index.html à la racine).");
  });

  it("Vite : l'index.html des sources ne compte pas comme site construit", () => {
    const check = checkVersion(["index.html", "vite.config.ts", "package.json", "src/main.ts"], pkg({ build: "tsc && vite build" }));
    expect(check).toMatchObject({ code: "unbuilt", framework: "Vite", command: "npm run build", outDir: "dist/", buildScript: "tsc && vite build" });
    expect(check!.message).toBe("Projet Vite non construit : lancez npm run build sur votre PC, puis envoyez le dossier dist/.");
    // Construit : le contenu de dist/ à la racine, sans vite.config.
    expect(checkVersion(["index.html", "assets/index-4f2a.js", "assets/index-9c1b.css"], null)).toBeNull();
  });

  it("Next.js : export statique dans out/, gestionnaire de paquets d'après le verrou", () => {
    const check = checkVersion(["next.config.mjs", "package.json", "pnpm-lock.yaml", "app/page.tsx"], pkg({ build: "next build" }));
    expect(check).toMatchObject({ code: "unbuilt", framework: "Next.js", command: "pnpm run build", outDir: "out/" });
    expect(check!.message).toBe('Projet Next.js non construit : lancez pnpm run build sur votre PC (avec output: "export" dans next.config), puis envoyez le dossier out/.');
    expect(checkVersion(["index.html", "404.html", "_next/static/chunks/main-1a2b.js"], null)).toBeNull();
    expect(checkVersion(["next.config.js", "package.json", "yarn.lock", "out/index.html"], pkg({ build: "next build" }))).toMatchObject({ code: "output_folder", outDir: "out/" });
  });

  it("Hugo : hugo.toml ou config.toml avec content/, commande hugo, sortie public/", () => {
    const check = checkVersion(["hugo.toml", "content/_index.md", "layouts/index.html", "static/logo.svg"], null);
    expect(check).toMatchObject({ code: "unbuilt", framework: "Hugo", command: "hugo", outDir: "public/" });
    expect(check!.message).toBe("Projet Hugo non construit : lancez hugo sur votre PC, puis envoyez le dossier public/.");
    expect(checkVersion(["config.toml", "content/posts/premier.md", "themes/t/theme.toml"], null)).toMatchObject({ framework: "Hugo" });
    expect(checkVersion(["hugo.toml", "content/_index.md", "public/index.html"], null)).toMatchObject({ code: "output_folder", outDir: "public/" });
    expect(checkVersion(["index.html", "index.xml", "posts/premier/index.html", "sitemap.xml"], null)).toBeNull();
  });

  it("autres frameworks : Nuxt (generate), SvelteKit, Gatsby, Eleventy, Jekyll", () => {
    expect(checkVersion(["nuxt.config.ts", "package.json", "pages/index.vue"], pkg({ build: "nuxt build", generate: "nuxt generate" }))).toMatchObject({
      framework: "Nuxt",
      command: "npm run generate",
      outDir: ".output/public/",
    });
    expect(checkVersion(["svelte.config.js", "package.json", "src/routes/+page.svelte"], pkg({ build: "vite build" }))).toMatchObject({ framework: "SvelteKit", outDir: "build/" });
    expect(checkVersion(["gatsby-config.js", "package.json", "src/pages/index.js"], pkg({ build: "gatsby build" }))).toMatchObject({ framework: "Gatsby", outDir: "public/" });
    expect(checkVersion([".eleventy.js", "index.md"], null)).toMatchObject({ framework: "Eleventy", command: "npx @11ty/eleventy", outDir: "_site/" });
    expect(checkVersion(["_config.yml", "index.html", "_posts/2026-10-19-bonjour.md"], null)).toMatchObject({ framework: "Jekyll", command: "bundle exec jekyll build", outDir: "_site/" });
  });

  it("package.json avec un script build mais framework inconnu : dossier de sortie « souvent dist/ »", () => {
    const check = checkVersion(["package.json", "src/app.js"], pkg({ build: "webpack --mode production" }));
    expect(check).toMatchObject({ code: "unbuilt", framework: null, command: "npm run build", buildScript: "webpack --mode production" });
    expect(check!.message).toBe("Projet non construit : lancez npm run build sur votre PC, puis envoyez le dossier de sortie (souvent dist/).");
    // Site statique avec un package.json d'outillage et son index.html à la racine : rien à signaler.
    expect(checkVersion(["index.html", "package.json", "style.css"], pkg({ lint: "eslint ." }))).toBeNull();
  });

  it("site statique sans index.html à la racine : avertissement ; aucun fichier : rien", () => {
    expect(checkVersion(["page.html", "style.css"], null)).toMatchObject({
      code: "no_index",
      message: "Pas de fichier index.html à la racine : le site n'aura pas de page d'accueil.",
    });
    expect(checkVersion([], null)).toBeNull();
    // package.json illisible : traité comme absent.
    expect(checkVersion(["package.json", "page.html"], "{ pas du json")).toMatchObject({ code: "no_index" });
  });

  it("cas réel : KouziaWebsite envoyé sans dist/ (chemins retenus par le hub)", () => {
    const fixture = JSON.parse(readFileSync(new URL("../fixtures/kouziawebsite.json", import.meta.url), "utf8")) as { paths: string[]; packageJson: string };
    expect(fixture.paths.length).toBeGreaterThan(400);
    expect(fixture.paths).not.toContain("index.html");
    expect(checkVersion(fixture.paths, fixture.packageJson)).toEqual({
      code: "unbuilt",
      framework: "Astro",
      command: "npm run build",
      outDir: "dist/",
      buildScript: "astro build",
      message: "Projet Astro non construit : lancez npm run build sur votre PC, puis envoyez le dossier dist/.",
    });
  });
});
