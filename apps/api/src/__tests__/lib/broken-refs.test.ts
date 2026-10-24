import { describe, expect, it } from "vitest";
import { extractReferences, findBrokenReferences, resolveReference } from "@/lib/broken-refs.js";
import { classifySitePath, serverAppOf } from "@/lib/site-paths.js";

describe("fichiers refusés à l'envoi (dépôt, éditeurs, assistants)", () => {
  it.each([".claude/settings.json", ".cursor/rules/x.mdc", ".vscode/settings.json", ".idea/workspace.xml", "assets/.claude/x"])("%s : dossier refusé", (p) => {
    expect(classifySitePath(p)).toMatchObject({ action: "reject", reason: expect.stringMatching(/^Dossier \.\w+ refusé/) });
  });

  it.each([".gitignore", ".gitattributes", "lib/.gitmodules", "README", "README.md", "readme.txt", "docs/ReadMe.HTML", "vendor/lib/README.markdown"])(
    "%s : fichier du dépôt refusé, même avec une exception",
    (p) => {
      expect(classifySitePath(p, { allow: [p] })).toEqual({ action: "reject", reason: "Fichier du dépôt refusé (README, .gitignore, .gitattributes) : inutile dans un site." });
    },
  );

  it.each(["readme-site.html", "readmes.txt", "assets/readme.png", "assets/readme.webp"])("%s : accepté (nom README exact, extension de document)", (p) => {
    expect(classifySitePath(p).action).toBe("accept");
  });

  it("composer.json : outillage refusé, autorisable par exception ; .env jamais", () => {
    expect(classifySitePath("composer.json").action).toBe("reject");
    expect(classifySitePath("composer.json", { allow: ["composer.json"] }).action).toBe("accept");
    expect(classifySitePath(".env", { allow: [".env"] }).action).toBe("reject");
  });
});

describe("site dynamique reconnu", () => {
  it("application PHP (MyTakumi) : public/index.php sans index.html", () => {
    const paths = ["public/index.php", "app/Kernel.php", "templates/home.php", "public/css/app.css"];
    expect(serverAppOf(paths)).toEqual({ language: "PHP", kind: "app", count: 3, examples: ["public/index.php", "app/Kernel.php", "templates/home.php"] });
    expect(serverAppOf(["index.php", "style.css"])).toMatchObject({ language: "PHP", kind: "app" });
  });

  it("site statique avec un script de formulaire : simples fichiers ; sans code serveur : rien", () => {
    expect(serverAppOf(["index.html", "contact.php", "style.css"])).toMatchObject({ language: "PHP", kind: "files", count: 1 });
    expect(serverAppOf(["index.html", "index.php"])).toMatchObject({ kind: "files" });
    expect(serverAppOf(["index.html", "style.css", "requirements.txt"])).toBeNull();
  });

  it("Python et Ruby : langage le plus présent, signé par son manifeste", () => {
    expect(serverAppOf(["manage.py", "blog/views.py", "blog/models.py", "static/a.css"])).toMatchObject({ language: "Python", kind: "app", count: 3 });
    expect(serverAppOf(["Gemfile", "app.rb"])).toMatchObject({ language: "Ruby", kind: "app" });
  });
});

describe("références vers des fichiers refusés", () => {
  it("extrait attributs, srcset, styles en ligne, url() et @import, sans les commentaires", () => {
    const html = `<!-- <img src="src/old.png"> --><img src="src/logo.png" srcset="a.png 1x, src/b@2x.png 2x"><link href='css/site.css'>
      <div style="background:url(src/bg.jpg)"></div><a href=page.html#x>x</a>`;
    expect(extractReferences(html, "html").sort()).toEqual(["a.png", "css/site.css", "page.html#x", "src/b@2x.png", "src/bg.jpg", "src/logo.png"]);
    expect(extractReferences(`@import "base.css"; /* url(no.png) */ .a{background:url( '../img/x.png' )}`, "css").sort()).toEqual(["../img/x.png", "base.css"]);
  });

  it("résout depuis le fichier, la racine pour « / » ; ignore l'externe, les ancres, les gabarits et ce qui sort du site", () => {
    expect(resolveReference("pages/a.html", "../src/logo.png?v=2")).toBe("src/logo.png");
    expect(resolveReference("css/site.css", "/src/fonts/x.woff2")).toBe("src/fonts/x.woff2");
    expect(resolveReference("index.html", "src/Logo%20blanc.png")).toBe("src/Logo blanc.png");
    for (const ref of ["https://cdn.example/x.js", "//cdn.example/x.js", "#top", "data:image/png;base64,AA", "mailto:a@b.fr", "{{ asset }}", "../../x.png", ""]) {
      expect(resolveReference("index.html", ref), ref).toBeNull();
    }
  });

  it("signale src/ (autorisable) et node_modules (jamais), une fois par page ; une exception exacte lève l'alerte", () => {
    const files = [
      { path: "index.html", text: `<img src="src/branding/Logo-blanc.png"><img src="src/branding/Logo-blanc.png"><link rel="icon" href="favicon.ico"><script src="node_modules/x/x.js"></script>` },
      { path: "css/site.css", text: `.a{background:url(../src/bg.jpg)}` },
    ];
    expect(findBrokenReferences(files)).toEqual([
      { from: "index.html", target: "src/branding/Logo-blanc.png", exceptable: true },
      { from: "index.html", target: "node_modules/x/x.js", exceptable: false },
      { from: "css/site.css", target: "src/bg.jpg", exceptable: true },
    ]);
    expect(findBrokenReferences(files, { allow: ["src/branding/Logo-blanc.png", "src/bg.jpg"] })).toEqual([{ from: "index.html", target: "node_modules/x/x.js", exceptable: false }]);
  });
});
