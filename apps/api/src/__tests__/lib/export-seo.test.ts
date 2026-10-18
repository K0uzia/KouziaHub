import { describe, expect, it } from "vitest";
import { analyzeHtml, buildRobots, buildSitemap, excludedFromSitemap, pageUrl, parseSitemap, robotsBlocksAll, robotsSitemaps } from "@/lib/export/seo.js";

describe("SEO de l'export", () => {
  it("faits d'une page : titre, description, canonical, noindex, X-Robots-Tag en meta", () => {
    const html = `<html><head><title> Accueil </title><meta name="description" content="Texte"><link href='https://a.fr/' rel="canonical"><meta name="ROBOTS" content="noindex,follow"><meta http-equiv="X-Robots-Tag" content="none"></head></html>`;
    expect(analyzeHtml(html)).toEqual({ title: true, description: true, canonical: "https://a.fr/", noindex: true, xRobotsMeta: true });
    expect(analyzeHtml("<title></title><meta name=description content=''>")).toMatchObject({ title: false, description: false, canonical: null, noindex: false });
    expect(analyzeHtml('<meta name="robots" content="index, follow">').noindex).toBe(false);
  });

  it("robots.txt : « Disallow: / » pour tous, et lignes Sitemap", () => {
    expect(robotsBlocksAll("User-agent: *\nDisallow: /\n")).toBe(true);
    expect(robotsBlocksAll("User-agent: *\nDisallow: /admin/\n")).toBe(false);
    expect(robotsBlocksAll("User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n")).toBe(false);
    expect(robotsSitemaps("User-agent: *\nAllow: /\nSitemap: https://a.fr/sitemap.xml\n")).toEqual(["https://a.fr/sitemap.xml"]);
    expect(buildRobots(null)).toBe("User-agent: *\nAllow: /\n");
  });

  it("adresses alignées sur le .htaccess (dossier/ ; .html gardé) et exclusions", () => {
    expect(pageUrl("https://www.a.fr", "index.html")).toBe("https://www.a.fr/");
    expect(pageUrl("https://www.a.fr", "contact/index.html")).toBe("https://www.a.fr/contact/");
    expect(pageUrl("https://www.a.fr", "page.html")).toBe("https://www.a.fr/page.html");
    expect(pageUrl("https://www.a.fr", "été/page 2.html")).toBe("https://www.a.fr/%C3%A9t%C3%A9/page%202.html");
    expect(excludedFromSitemap("404.html", "404.html")).toBe(true);
    expect(excludedFromSitemap("erreur.html", "erreur.html")).toBe(true);
    expect(excludedFromSitemap("google0123abcd.html", "404.html")).toBe(true);
    expect(excludedFromSitemap("contact/index.html", "404.html")).toBe(false);
  });

  it("sitemap généré, relu, et index distingué", () => {
    const xml = buildSitemap(["https://a.fr/?x=1&y=2"], "2026-10-18T10:00:00.000Z");
    expect(xml).toContain("<loc>https://a.fr/?x=1&amp;y=2</loc>");
    expect(parseSitemap(xml)).toEqual({ kind: "urlset", locs: ["https://a.fr/?x=1&y=2"] });
    expect(parseSitemap('<sitemapindex><sitemap><loc>https://a.fr/sitemap-0.xml</loc></sitemap></sitemapindex>').kind).toBe("index");
  });
});

describe("analyses linéaires : entrées piégées sous 100 ms", () => {
  const timed = (fn: () => unknown) => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };

  it("robots.txt de 50 000 lignes vides puis une ligne Sitemap", () => {
    const text = `${"\n".repeat(50_000)}Sitemap: https://a.fr/sitemap.xml\n`;
    let found: string[] = [];
    expect(timed(() => (found = robotsSitemaps(text)))).toBeLessThan(100);
    expect(found).toEqual(["https://a.fr/sitemap.xml"]);
    expect(timed(() => robotsBlocksAll(`${"User-agent: *\n".repeat(20_000)}${" ".repeat(100_000)}`))).toBeLessThan(100);
  });

  it("sitemap : <loc> suivis de 2 000 blancs sans fermeture, répétés", () => {
    const xml = `<urlset>${`<loc>${" ".repeat(2000)}`.repeat(2000)}</urlset>`;
    expect(timed(() => parseSitemap(xml))).toBeLessThan(100);
    expect(parseSitemap("<urlset><loc>  https://a.fr/  </loc></urlset>").locs).toEqual(["https://a.fr/"]);
  });

  it("2 Mio de « <meta » répétés, et une balise ouverte sans fin", () => {
    const html = "<meta".repeat(400_000);
    expect(timed(() => analyzeHtml(html))).toBeLessThan(100);
    expect(timed(() => analyzeHtml(`<head><meta name="description" content="${"a".repeat(2_000_000)}`))).toBeLessThan(100);
    expect(timed(() => analyzeHtml(`<head>${'<link rel="canonical" href="x">'.repeat(60_000)}</head>`))).toBeLessThan(100);
  });
});
