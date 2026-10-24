import type { BrokenReference } from "@/contract.js";
import { classifySitePath, devToolingOf, normalizeSitePath } from "@/lib/site-paths.js";

// Après un envoi : une page ou une feuille de style qui référence un fichier refusé (src/branding/logo.png d'un
// site en HTML simple) sera cassée en ligne sans autre signe. On relit les HTML et CSS reçus, on résout leurs
// chemins locaux et on signale ceux que la règle d'envoi refuse. Lecture seule : rien n'est corrigé ni exécuté.

/** Pages et feuilles de style relues, et taille lue au plus par fichier. */
export const REF_FILE_RE = /\.(?:html?|css)$/i;
export const MAX_REF_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_REF_FILES = 300;
/** Références signalées au plus (le compte rendu en montre une partie). */
export const MAX_BROKEN_REFS = 200;

const HTML_ATTR_RE = /\b(?:src|href|poster|data-src|srcset|data-srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;

function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

function matches(re: RegExp, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/** Références brutes d'une page (attributs, plus les url() de ses styles) ou d'une feuille de style. */
export function extractReferences(text: string, kind: "html" | "css"): string[] {
  const clean = stripComments(text);
  const refs = [...matches(CSS_URL_RE, clean), ...matches(CSS_IMPORT_RE, clean)];
  if (kind === "html") {
    for (const m of clean.matchAll(HTML_ATTR_RE)) {
      const value = m[1] ?? m[2] ?? m[3] ?? "";
      // srcset : « image.png 2x, autre.png 640w » ; un attribut simple ne contient pas de virgule de ce genre.
      if (/srcset\s*=/i.test(m[0])) refs.push(...value.split(",").map((part) => part.trim().split(/\s+/)[0] ?? ""));
      else refs.push(value);
    }
  }
  return refs;
}

/**
 * Chemin du site visé par une référence locale, depuis le fichier qui la contient ; null pour une adresse externe,
 * une ancre, une donnée en ligne, un gabarit ou un chemin qui sort du site.
 */
export function resolveReference(fromPath: string, raw: string): string | null {
  let ref = raw.trim().replace(/&amp;/g, "&");
  if (!ref || ref.startsWith("#") || ref.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(ref) || /\{\{|\$\{|<%/.test(ref)) return null;
  ref = ref.replace(/[?#].*$/, "");
  if (!ref) return null;
  try {
    ref = decodeURIComponent(ref);
  } catch {
    return null;
  }
  const base = ref.startsWith("/") ? [] : fromPath.split("/").slice(0, -1);
  const out = [...base];
  for (const segment of ref.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(segment);
  }
  if (!out.length) return null;
  const normalized = normalizeSitePath(out.join("/"));
  return normalized.ok ? normalized.path : null;
}

/**
 * Références vers un fichier refusé à l'envoi (donc jamais servi), une fois par couple page et cible.
 * exceptable : l'onglet Serveur peut l'autoriser (outillage comme src/) ; sinon jamais (.env, .git, node_modules...).
 */
export function findBrokenReferences(files: Array<{ path: string; text: string }>, allow: readonly string[] = []): BrokenReference[] {
  const seen = new Set<string>();
  const out: BrokenReference[] = [];
  for (const file of files) {
    const kind = /\.css$/i.test(file.path) ? "css" : "html";
    for (const raw of extractReferences(file.text, kind)) {
      const target = resolveReference(file.path, raw);
      if (!target || classifySitePath(target, { allow }).action !== "reject") continue;
      const key = `${file.path}\n${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from: file.path, target, exceptable: devToolingOf(target) !== null });
      if (out.length >= MAX_BROKEN_REFS) return out;
    }
  }
  return out;
}
