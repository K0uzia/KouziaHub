// SEO technique de l'export de production (règle web-seo) : lecture du HTML, des robots.txt et des sitemaps
// par des parcours LINÉAIRES (indexOf et boucles, aucune expression régulière à retour arrière sur le
// contenu), avec des entrées et des valeurs de longueur bornée. Génération des fichiers manquants.

/** Au-delà, une page n'est pas analysée (signalé au résumé). */
export const HTML_ANALYSIS_MAX_BYTES = 2 * 1024 * 1024;
/** Partie lue d'une page : l'en-tête (<head>) suffit, plafonné. */
export const HEAD_MAX_CHARS = 256 * 1024;
export const ROBOTS_MAX_CHARS = 512 * 1024;
export const SITEMAP_MAX_CHARS = 10 * 1024 * 1024;
const TAG_MAX = 4000;
const VALUE_MAX = 2048;
const LINE_MAX = 4096;

const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
const isNameChar = (c: string) => /[A-Za-z0-9_:.-]/.test(c);

/** Attributs d'une balise (texte entre « <nom » et « > »), en un seul passage. */
export function parseAttributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  const n = Math.min(tag.length, TAG_MAX);
  while (i < n) {
    while (i < n && (isSpace(tag[i]!) || tag[i] === "/")) i++;
    const start = i;
    while (i < n && isNameChar(tag[i]!)) i++;
    if (i === start) {
      i++;
      continue;
    }
    const name = tag.slice(start, i).toLowerCase();
    while (i < n && isSpace(tag[i]!)) i++;
    if (tag[i] !== "=") {
      out[name] ??= "";
      continue;
    }
    i++;
    while (i < n && isSpace(tag[i]!)) i++;
    let value: string;
    const quote = tag[i];
    if (quote === '"' || quote === "'") {
      const end = tag.indexOf(quote, i + 1);
      const stop = end === -1 ? n : Math.min(end, n);
      value = tag.slice(i + 1, stop);
      i = stop + 1;
    } else {
      const start2 = i;
      while (i < n && !isSpace(tag[i]!) && tag[i] !== ">") i++;
      value = tag.slice(start2, i);
    }
    out[name] ??= value.slice(0, VALUE_MAX).trim();
  }
  return out;
}

/** En-tête de la page : jusqu'à </head> (ou <body>), plafonné. */
function headOf(html: string): string {
  const slice = html.slice(0, HEAD_MAX_CHARS);
  const lower = slice.toLowerCase();
  const end = lower.indexOf("</head");
  const body = lower.indexOf("<body");
  const stop = [end, body].filter((x) => x >= 0);
  return stop.length ? slice.slice(0, Math.min(...stop)) : slice;
}

/** Balises <nom ...> d'un texte : attributs de chacune, parcours par indexOf. */
function tags(text: string, name: string): Array<Record<string, string>> {
  const lower = text.toLowerCase();
  const open = `<${name}`;
  const out: Array<Record<string, string>> = [];
  let pos = 0;
  for (;;) {
    const at = lower.indexOf(open, pos);
    if (at === -1) break;
    const after = lower[at + open.length];
    pos = at + open.length;
    if (after !== undefined && !isSpace(after) && after !== ">" && after !== "/") continue;
    const close = lower.indexOf(">", pos);
    if (close === -1) break;
    if (close - pos <= TAG_MAX) out.push(parseAttributes(text.slice(pos, close)));
    pos = close + 1;
  }
  return out;
}

function hasTitle(head: string): boolean {
  const lower = head.toLowerCase();
  const at = lower.indexOf("<title");
  if (at === -1) return false;
  const open = lower.indexOf(">", at);
  if (open === -1) return false;
  const end = lower.indexOf("</title", open);
  const content = head.slice(open + 1, end === -1 ? Math.min(head.length, open + 1 + VALUE_MAX) : Math.min(end, open + 1 + VALUE_MAX));
  return content.trim() !== "";
}

export type HtmlFacts = {
  title: boolean;
  description: boolean;
  canonical: string | null;
  noindex: boolean;
  xRobotsMeta: boolean;
};

const hasWord = (text: string, word: string) =>
  text
    .toLowerCase()
    .split(/[\s,]+/)
    .includes(word);

/** Faits SEO d'une page : titre, description, canonical, noindex (meta robots ou googlebot), X-Robots-Tag en meta. */
export function analyzeHtml(html: string): HtmlFacts {
  const head = headOf(html);
  const metas = tags(head, "meta");
  const links = tags(head, "link");
  const robots = metas.filter((m) => ["robots", "googlebot"].includes((m.name ?? "").toLowerCase()));
  const canonical = links.find((l) => hasWord(l.rel ?? "", "canonical"));
  return {
    title: hasTitle(head),
    description: metas.some((m) => (m.name ?? "").toLowerCase() === "description" && (m.content ?? "").trim() !== ""),
    canonical: canonical?.href ? canonical.href : null,
    noindex: robots.some((m) => hasWord(m.content ?? "", "noindex") || hasWord(m.content ?? "", "none")),
    xRobotsMeta: metas.some((m) => (m["http-equiv"] ?? "").toLowerCase() === "x-robots-tag"),
  };
}

/** Lignes « clé: valeur » d'un robots.txt, commentaires retirés (taille et longueur de ligne bornées). */
function robotsLines(text: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const raw of text.slice(0, ROBOTS_MAX_CHARS).split("\n")) {
    let line = raw.slice(0, LINE_MAX);
    const hash = line.indexOf("#");
    if (hash !== -1) line = line.slice(0, hash);
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!key) continue;
    out.push({ key, value: line.slice(colon + 1).trim() });
  }
  return out;
}

/** Le robots.txt ferme-t-il tout le site (« Disallow: / » pour User-agent: *) ? */
export function robotsBlocksAll(text: string): boolean {
  let agents: string[] = [];
  let inRules = false;
  for (const { key, value } of robotsLines(text)) {
    if (key === "user-agent") {
      if (inRules) agents = [];
      inRules = false;
      agents.push(value);
    } else {
      inRules = true;
      if (key === "disallow" && value === "/" && agents.includes("*")) return true;
    }
  }
  return false;
}

export function robotsSitemaps(text: string): string[] {
  return robotsLines(text)
    .filter((l) => l.key === "sitemap" && l.value)
    .map((l) => l.value.split(/\s/)[0]!.slice(0, VALUE_MAX));
}

export type SitemapDoc = { kind: "index" | "urlset" | "unknown"; locs: string[] };

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** <loc> d'un sitemap ou d'un index, par indexOf (valeurs de 2 048 caractères au plus). */
export function parseSitemap(xml: string): SitemapDoc {
  const text = xml.slice(0, SITEMAP_MAX_CHARS);
  const lower = text.toLowerCase();
  const head = lower.slice(0, 4096);
  const kind = head.includes("<sitemapindex") ? "index" : head.includes("<urlset") ? "urlset" : "unknown";
  const locs: string[] = [];
  let pos = 0;
  for (;;) {
    const at = lower.indexOf("<loc>", pos);
    if (at === -1) break;
    const start = at + 5;
    const end = lower.indexOf("</loc>", start);
    if (end === -1) break;
    if (end - start <= VALUE_MAX + 64) {
      const value = decodeXml(text.slice(start, end).trim());
      if (value && value.length <= VALUE_MAX) locs.push(value);
    }
    pos = end + 6;
  }
  return { kind, locs };
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * URL publique d'une page, alignée sur le .htaccess généré (server-config.ts) : /dossier/index.html
 * redirige vers /dossier/, l'extension .html des autres pages est gardée.
 */
export function pageUrl(origin: string, sitePath: string): string {
  const encoded = sitePath.split("/").map(encodeURIComponent).join("/");
  if (sitePath === "index.html") return `${origin}/`;
  if (sitePath.endsWith("/index.html")) return `${origin}/${encoded.slice(0, -"index.html".length)}`;
  return `${origin}/${encoded}`;
}

/** Pages à ne jamais lister : 404, page 404 du profil, vérification Google Search Console. */
export function excludedFromSitemap(sitePath: string, notFoundPath: string): boolean {
  const base = sitePath.split("/").pop()!.toLowerCase();
  return sitePath === "404.html" || sitePath === notFoundPath || /^google[0-9a-z]{1,64}\.html$/.test(base);
}

export function buildSitemap(urls: string[], lastmod: string): string {
  const body = urls.map((u) => `  <url>\n    <loc>${xmlEscape(u)}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

/** robots.txt qui autorise tout, avec la ligne Sitemap absolue si le domaine final est connu. */
export function buildRobots(sitemapUrl: string | null): string {
  return `User-agent: *\nAllow: /\n${sitemapUrl ? `\nSitemap: ${sitemapUrl}\n` : ""}`;
}

/** Hôte d'une URL absolue, null si illisible. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url.slice(0, VALUE_MAX)).host.toLowerCase();
  } catch {
    return null;
  }
}
