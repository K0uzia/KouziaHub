// Export de production d'une version : fichiers sans rien de développement ni de propre à la version de
// travail, configuration de l'hébergement final générée depuis le profil serveur, SEO technique préparé.
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import yazl from "yazl";
import type { Site, Version, VersionFile } from "@prisma/client";
import type { ExportIssue, ExportSummary, ExportTarget, RejectedFile } from "@/contract.js";
import { HttpError } from "@/lib/http.js";
import { finalHost } from "@/lib/monitor/targets.js";
import { prisma } from "@/lib/prisma.js";
import { buildHtaccess, buildPagesRedirects, buildProductionPagesHeaders, GENERATED_MARKER, HTACCESS_PATH, siteContentOf } from "@/lib/server-config.js";
import { fullProfileOf } from "@/lib/server-config-store.js";
import type { Services } from "@/lib/services.js";
import { classifySitePath } from "@/lib/site-paths.js";
import {
  analyzeHtml,
  buildRobots,
  buildSitemap,
  excludedFromSitemap,
  hostOf,
  HTML_ANALYSIS_MAX_BYTES,
  pageUrl,
  parseSitemap,
  robotsBlocksAll,
  robotsSitemaps,
} from "@/lib/export/seo.js";

/** Pages listées au plus par écart (le total reste donné). */
export const ISSUE_PATHS_MAX = 20;
const NO_FINAL_DOMAIN = "Renseignez le domaine final (onglet Serveur) pour le sitemap et la forme canonique.";

type Entry = { path: string; size: number; sha256?: string; content?: Buffer };

export type ExportPlan = { site: Site; version: Version; target: ExportTarget; entries: Entry[]; summary: ExportSummary };

const EXPORT_DENIED_NAMES = new Set(["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", ".gitignore", ".npmrc", ".editorconfig"]);

/**
 * Refus propres à l'export (en plus de la règle partagée de l'envoi, qui reste permissive pour
 * l'explorateur) : notes Markdown, manifestes et verrous de paquets, configuration TypeScript, fichiers
 * cachés sauf /.well-known/ et le .htaccess (remplacé par celui du profil).
 */
export function exportRejectReason(sitePath: string): string | null {
  const segments = sitePath.split("/");
  const base = segments[segments.length - 1]!.toLowerCase();
  if (sitePath === HTACCESS_PATH) return null;
  if (base.endsWith(".md") || base.endsWith(".markdown")) return "Note Markdown : fichier de développement, non publié.";
  if (EXPORT_DENIED_NAMES.has(base)) return "Fichier de projet ou de dépendances : non publié.";
  if (base.startsWith("tsconfig") && base.endsWith(".json")) return "Configuration TypeScript : non publiée.";
  if (segments.some((seg, i) => seg.startsWith(".") && !(i === 0 && seg === ".well-known"))) return "Fichier caché : non publié.";
  return null;
}

const issue = (level: ExportIssue["level"], code: ExportIssue["code"], message: string, paths: string[] = []): ExportIssue => ({
  level,
  code,
  message,
  paths: paths.slice(0, ISSUE_PATHS_MAX),
  total: paths.length,
});

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Page 404 sobre, en français, sans contenu inventé (générée si le site n'en a pas). */
export const DEFAULT_404_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page introuvable</title>
<style>
body { display: grid; min-height: 100vh; margin: 0; padding: 1rem; place-items: center; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1d1d1f; background: #f7f7f8; }
@media (prefers-color-scheme: dark) { body { color: #f2f2f3; background: #151517; } a { color: #9ecbff; } }
main { max-width: 36rem; text-align: center; }
</style>
</head>
<body>
<main>
<h1>Page introuvable</h1>
<p>L'adresse demandée n'existe pas ou a changé.</p>
<p><a href="/">Retour à l'accueil</a></p>
</main>
</body>
</html>
`;

function readme(site: Site, target: ExportTarget, origin: string | null, notFound: string): string {
  const lines = [
    `Version de production du site ${site.slug}`,
    "",
    target === "hostinger"
      ? [
          "Où déposer les fichiers",
          "Déposez tout le contenu de ce dossier (pas le dossier lui-même) dans public_html chez Hostinger,",
          "avec le gestionnaire de fichiers ou en FTP. Le fichier .htaccess est caché : vérifiez qu'il est bien envoyé.",
          "",
          "Ce que fait le fichier .htaccess",
          "- HTTPS obligatoire (redirection 301).",
          origin ? `- Une seule adresse : ${origin} (redirection 301 de l'autre forme, avec ou sans www).` : "- Aucune redirection d'hôte : le domaine final n'était pas renseigné dans le hub.",
          "- En-têtes de sécurité (CSP, nosniff, Referrer-Policy, Permissions-Policy, X-Frame-Options).",
          "- Cache : fichiers au nom haché 1 an, CSS et JS 7 jours, images 30 jours, HTML revalidé.",
          "- Compression Brotli ou Gzip si l'hébergeur la propose.",
          `- Page d'erreur 404 : ${notFound}.`,
          "- Fichiers de développement et fichiers cachés refusés (403).",
        ].join("\n")
      : [
          "Où déposer les fichiers",
          "Ce dossier est prêt pour Cloudflare Pages (envoi direct) : déposez son contenu tel quel.",
          "Les fichiers _headers et _redirects règlent le cache et les redirections.",
        ].join("\n"),
    "",
    "Référencement",
    origin
      ? `robots.txt autorise l'exploration et indique le sitemap ; les adresses du sitemap sont en ${origin}.`
      : "Le domaine final n'était pas renseigné : pas de sitemap, et un robots.txt qui autorise tout.",
    "",
    "À vérifier après la mise en ligne",
    "- L'accueil s'ouvre en HTTPS, sans avertissement du navigateur.",
    origin ? `- L'autre forme de l'adresse redirige vers ${origin}.` : "- La redirection www ou sans www, une fois le domaine final choisi.",
    "- Une adresse inexistante affiche la page 404 (statut 404).",
    "- robots.txt et sitemap répondent, puis le sitemap est déclaré dans la Google Search Console.",
    "- Aucune balise noindex ne reste dans les pages (voir le résumé de l'export dans le hub).",
    "",
  ];
  return lines.join("\n");
}

/** Prépare l'export (sans rien écrire) : liste des fichiers du zip et résumé avec les écarts. */
export async function buildExportPlan(services: Services, siteId: string, versionId: string | undefined, target: ExportTarget): Promise<ExportPlan> {
  const site = await prisma.site.findUnique({ where: { id: siteId } });
  if (!site) throw new HttpError(404, "Site introuvable.");
  const id = versionId ?? site.currentVersionId;
  if (!id) throw new HttpError(409, "Rien n'est encore publié : publiez une version avant de l'extraire.", "nothing_published");
  const version = await prisma.version.findFirst({ where: { id, siteId }, include: { files: true } });
  if (!version) throw new HttpError(404, "Version introuvable.");
  if (version.status === "PURGED") throw new HttpError(409, "Version purgée : ses fichiers ne sont plus gardés.");
  if (version.status === "UPLOADING") throw new HttpError(409, "Version en cours d'envoi.");
  if (version.source === "placeholder") throw new HttpError(409, "Seule la page d'attente est publiée : rien à extraire.", "nothing_published");

  const profile = await fullProfileOf(site);
  const origin = profile.finalDomain ? `https://${finalHost(profile.finalDomain, profile.canonicalHost)}` : null;
  const canonicalHost = origin ? new URL(origin).host : null;
  const notFoundPath = profile.notFoundPage.slice(1);
  const issues: ExportIssue[] = [];
  const removed: RejectedFile[] = [];
  const generated: string[] = [];
  const entries: Entry[] = [];
  const files = new Map<string, VersionFile>();
  const read = async (f: VersionFile) => {
    try {
      return await services.blobs.read(f.sha256);
    } catch {
      throw missingBlob(f.path);
    }
  };
  const addGenerated = (path: string, text: string) => {
    const content = Buffer.from(text, "utf8");
    entries.push({ path, size: content.length, content });
    generated.push(path);
  };

  const devRemoved: string[] = [];
  const pagesRemoved: string[] = [];
  let versionHtaccess: VersionFile | null = null;
  const user: { headers?: string; redirects?: string } = {};
  for (const f of version.files) {
    const verdict = classifySitePath(f.path, { allow: profile.allow });
    const reason = verdict.action !== "accept" ? verdict.reason : exportRejectReason(f.path);
    if (reason) {
      removed.push({ path: f.path, reason });
      devRemoved.push(f.path);
      continue;
    }
    if (f.path === "_headers" || f.path === "_redirects") {
      const text = (await read(f)).toString("utf8");
      if (f.path === "_headers") user.headers = text;
      else user.redirects = text;
      if (target === "hostinger") {
        removed.push({ path: f.path, reason: "Fichier propre à Cloudflare Pages : retiré pour Hostinger (le .htaccess le remplace)." });
        pagesRemoved.push(f.path);
      }
      continue;
    }
    if (f.path === HTACCESS_PATH) {
      versionHtaccess = f;
      continue;
    }
    files.set(f.path, f);
  }
  if (devRemoved.length) issues.push(issue("info", "dev_files_removed", `${devRemoved.length} fichier(s) de développement retiré(s).`, devRemoved));
  if (pagesRemoved.length) issues.push(issue("info", "pages_files_removed", "Fichiers propres à Cloudflare Pages retirés (inutiles chez Hostinger).", pagesRemoved));
  if (!origin) issues.push(issue("warning", "no_final_domain", NO_FINAL_DOMAIN));

  // Configuration de l'hébergeur.
  if (target === "hostinger") {
    // Contenu de la version exportée (404, dossiers hashés, sitemap), pas celui de la version de travail.
    const generatedText = buildHtaccess(profile, siteContentOf(files.keys(), profile.notFoundPage));
    // Généré par le hub, même sous un profil antérieur (marqueur en tête) : remplacé par celui du profil actuel.
    const hubMade =
      versionHtaccess &&
      (versionHtaccess.sha256 === site.serverConfigHash ||
        versionHtaccess.sha256 === sha(Buffer.from(generatedText, "utf8")) ||
        (await read(versionHtaccess)).subarray(0, 256).toString("utf8").startsWith(GENERATED_MARKER));
    if (versionHtaccess && !hubMade) {
      // Modifié à la main : la version d'Alexandre fait foi, l'écart est signalé.
      entries.push({ path: HTACCESS_PATH, size: versionHtaccess.size, sha256: versionHtaccess.sha256 });
      issues.push(issue("warning", "htaccess_modified", "Le .htaccess de la version a été modifié à la main : il est exporté tel quel, sans la configuration générée par le hub.", [HTACCESS_PATH]));
    } else {
      addGenerated(HTACCESS_PATH, generatedText);
    }
  } else {
    const headers = buildProductionPagesHeaders(user.headers, profile.finalDomain);
    const redirects = buildPagesRedirects(user.redirects);
    if (headers) addGenerated("_headers", headers);
    if (redirects) addGenerated("_redirects", redirects);
  }

  // Page 404 : celle du profil ; absente, une page sobre est générée à sa place.
  if (!files.has(notFoundPath)) {
    addGenerated(notFoundPath, DEFAULT_404_HTML);
    issues.push(issue("warning", "no_404", `Page 404 absente (${profile.notFoundPage}) : une page sobre « Page introuvable » a été générée.`, [notFoundPath]));
  }
  if (target === "pages" && notFoundPath !== "404.html" && !files.has("404.html")) {
    const own = files.get(notFoundPath);
    if (own) entries.push({ path: "404.html", size: own.size, sha256: own.sha256 });
    else addGenerated("404.html", DEFAULT_404_HTML);
  }

  // Pages HTML : analyse bornée.
  const pages = [...files.values()].filter((f) => /\.html?$/i.test(f.path));
  const noindex: string[] = [];
  const xRobots: string[] = [];
  const noCanonical: string[] = [];
  const otherCanonical: string[] = [];
  const noTitle: string[] = [];
  const noDescription: string[] = [];
  const tooLarge: string[] = [];
  const indexable: string[] = [];
  for (const f of pages) {
    if (f.size > HTML_ANALYSIS_MAX_BYTES) {
      tooLarge.push(f.path);
      indexable.push(f.path);
      continue;
    }
    const facts = analyzeHtml((await read(f)).toString("utf8"));
    const isErrorPage = excludedFromSitemap(f.path, notFoundPath);
    if (facts.noindex) {
      if (!isErrorPage) noindex.push(f.path);
    } else if (!isErrorPage) {
      indexable.push(f.path);
    }
    if (isErrorPage) continue;
    if (facts.xRobotsMeta) xRobots.push(f.path);
    if (!facts.noindex) {
      if (!facts.canonical) noCanonical.push(f.path);
      else if (canonicalHost && hostOf(facts.canonical) !== canonicalHost) otherCanonical.push(f.path);
      if (!facts.title) noTitle.push(f.path);
      if (!facts.description) noDescription.push(f.path);
    }
  }
  if (noindex.length) issues.push(issue("warning", "noindex_meta", "Balise meta robots noindex dans des pages : elles ne seront pas indexées (exclues du sitemap généré).", noindex));
  if (xRobots.length) issues.push(issue("warning", "x_robots_meta", "Balise meta http-equiv X-Robots-Tag restée dans des pages.", xRobots));
  if (noCanonical.length) issues.push(issue("warning", "canonical_missing", "Balise canonical absente.", noCanonical));
  if (otherCanonical.length) issues.push(issue("warning", "canonical_domain", `Balise canonical vers un autre domaine que ${canonicalHost}.`, otherCanonical));
  if (noTitle.length) issues.push(issue("warning", "title_missing", "Balise <title> absente.", noTitle));
  if (noDescription.length) issues.push(issue("warning", "description_missing", "Balise meta description absente.", noDescription));
  if (tooLarge.length) issues.push(issue("info", "html_too_large", "Pages trop lourdes pour être analysées (plus de 2 Mio).", tooLarge));

  // robots.txt et sitemap. Le robots.txt de la version de travail (Disallow) est servi à la volée par le
  // _worker.js : il n'existe dans aucune version et ne peut donc pas entrer dans le zip.
  const robots = files.get("robots.txt");
  const robotsText = robots ? (await read(robots)).toString("utf8") : null;
  const declared = robotsText ? robotsSitemaps(robotsText) : [];
  if (robotsText) {
    if (robotsBlocksAll(robotsText)) issues.push(issue("error", "robots_blocking", "robots.txt contient « Disallow: / » : le site entier serait exclu des moteurs de recherche.", ["robots.txt"]));
    const foreign = declared.filter((u) => !canonicalHost || hostOf(u) !== canonicalHost);
    if (canonicalHost && foreign.length) issues.push(issue("warning", "robots_sitemap_domain", `La ligne Sitemap du robots.txt pointe vers un autre domaine que ${canonicalHost}.`, foreign));
  }
  const pathOfUrl = (u: string) => {
    try {
      return decodeURIComponent(new URL(u).pathname.replace(/^\/+/, ""));
    } catch {
      return null;
    }
  };
  const providedSitemaps = ["sitemap-index.xml", "sitemap.xml", ...declared.map(pathOfUrl).filter((p): p is string => !!p)].filter((p, i, a) => a.indexOf(p) === i && files.has(p));

  if (providedSitemaps.length > 0) {
    const foreignUrls: string[] = [];
    const missingChildren: string[] = [];
    const seen = new Set<string>();
    const queue = [...providedSitemaps];
    while (queue.length && seen.size < 50) {
      const p = queue.shift()!;
      if (seen.has(p)) continue;
      seen.add(p);
      const f = files.get(p);
      if (!f) {
        missingChildren.push(p);
        continue;
      }
      const doc = parseSitemap((await read(f)).toString("utf8").slice(0, HTML_ANALYSIS_MAX_BYTES * 5));
      for (const loc of doc.locs) {
        if (canonicalHost && hostOf(loc) !== canonicalHost) foreignUrls.push(loc);
        if (doc.kind === "index") {
          const child = pathOfUrl(loc);
          if (child) queue.push(child);
        }
      }
    }
    if (foreignUrls.length) issues.push(issue("warning", "sitemap_domain", `Adresses du sitemap hors de ${canonicalHost} (forme canonique comprise).`, foreignUrls));
    if (missingChildren.length) issues.push(issue("warning", "sitemap_child_missing", "Sitemap référencé par l'index mais absent de la version.", missingChildren));
  }

  if (origin) {
    let sitemapPath = providedSitemaps[0] ?? null;
    if (!sitemapPath) {
      sitemapPath = "sitemap.xml";
      const lastmod = (version.publishedAt ?? version.createdAt).toISOString();
      const urls = indexable.sort().map((p) => pageUrl(origin, p));
      addGenerated(sitemapPath, buildSitemap(urls, lastmod));
      issues.push(issue("info", "sitemap_generated", `sitemap.xml généré : ${urls.length} page(s) sur ${origin}.`));
    }
    if (!robotsText) {
      addGenerated("robots.txt", buildRobots(`${origin}/${sitemapPath}`));
      issues.push(issue("info", "robots_generated", "robots.txt généré : exploration autorisée, avec la ligne Sitemap."));
    }
  } else if (!robotsText) {
    addGenerated("robots.txt", buildRobots(null));
    issues.push(issue("info", "robots_generated", "robots.txt généré : exploration autorisée, sans ligne Sitemap (domaine final inconnu)."));
  }

  addGenerated("LISEZMOI.txt", readme(site, target, origin, profile.notFoundPage));

  // Fichiers de la version, après ceux générés (un nom généré ne remplace jamais un fichier du site).
  const taken = new Set(entries.map((e) => e.path));
  for (const f of files.values()) if (!taken.has(f.path)) entries.push({ path: f.path, size: f.size, sha256: f.sha256 });
  entries.sort((a, b) => a.path.localeCompare(b.path));

  const fileName = `${site.slug}-v${version.number}-production${target === "pages" ? "-pages" : ""}.zip`;
  return {
    site,
    version,
    target,
    entries,
    summary: {
      versionId: version.id,
      versionNumber: version.number,
      target,
      fileName,
      fileCount: entries.length,
      totalBytes: entries.reduce((s, e) => s + e.size, 0),
      finalDomain: profile.finalDomain,
      canonicalOrigin: origin,
      generated: generated.sort(),
      removed,
      issues,
    },
  };
}

const missingBlob = (filePath: string) =>
  new HttpError(409, `Le fichier « ${filePath} » de la version manque sur le serveur (purge récente ?) : republiez la version ou réessayez.`, "export_blob_missing");

/** Avant tout envoi : chaque fichier du plan existe encore dans le magasin d'objets (sinon 409 clair). */
export async function assertExportBlobs(services: Services, plan: ExportPlan): Promise<void> {
  for (const e of plan.entries) {
    if (e.sha256 && !(await services.blobs.has(e.sha256))) throw missingBlob(e.path);
  }
}

/**
 * Zip produit en flux (les fichiers sont lus un à un depuis le magasin d'objets). Toute erreur (fichier
 * disparu ou de taille inattendue en cours de route, erreur de yazl) coupe le flux de sortie et passe par
 * onError : jamais d'exception non rattrapée, l'API reste debout.
 */
export function streamExport(services: Services, plan: ExportPlan, onError: (err: Error) => void = () => undefined): Readable {
  const zip = new yazl.ZipFile();
  const out = zip.outputStream as unknown as Readable;
  const opened = new Set<Readable>();
  let failed = false;
  const fail = (err: Error) => {
    if (failed) return;
    failed = true;
    for (const s of opened) s.destroy();
    onError(err);
    out.destroy(err);
  };
  zip.on("error", fail);
  // Le flux peut échouer avant d'être branché sur la réponse (yazl lit dès l'ajout) : l'erreur est
  // toujours écoutée ici, la réponse est coupée par destroy().
  out.on("error", () => undefined);
  const mtime = plan.version.publishedAt ?? plan.version.createdAt;
  for (const e of plan.entries) {
    if (e.content) zip.addBuffer(e.content, e.path, { mtime, mode: 0o100644 });
    else {
      const hash = e.sha256!;
      zip.addReadStreamLazy(e.path, { mtime, mode: 0o100644, size: e.size }, (cb) => {
        const stream = services.blobs.stream(hash);
        opened.add(stream);
        stream.on("error", fail);
        stream.on("close", () => opened.delete(stream));
        cb(null, stream);
      });
    }
  }
  zip.end();
  return out;
}
