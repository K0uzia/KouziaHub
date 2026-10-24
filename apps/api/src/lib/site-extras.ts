import type { Site } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { normalizeSitePath } from "@/lib/site-paths.js";

// Réglages serveur propres à un site, onglet Serveur (colonnes Site.devFilesAllowed et Site.siteCsp, migration
// 20261019180000 validée par Alexandre) : exceptions aux fichiers de développement refusés, et CSP du site.

export type SiteExtras = {
  /** Chemins exacts servis malgré la règle des fichiers d'outillage (ni dossier ni joker). */
  devFilesAllowed: string[];
  /** CSP du site, ajoutée à la CSP de base (version de travail et export) sans l'affaiblir ; null : aucune. */
  siteCsp: string | null;
  /** Hébergement du site : décide de ce qu'un envoi garde (un site PHP garde src/ et composer.json). */
  hosting: "pages" | "php";
};

export const MAX_ALLOWED_PATHS = 50;
export const MAX_CSP_LENGTH = 2000;

/** Directives CSP reconnues (CSP niveau 3) : une faute de frappe ne passe pas en silence. */
const CSP_DIRECTIVES = new Set([
  "default-src", "script-src", "script-src-elem", "script-src-attr", "style-src", "style-src-elem", "style-src-attr",
  "img-src", "font-src", "connect-src", "media-src", "object-src", "frame-src", "child-src", "worker-src", "manifest-src",
  "frame-ancestors", "base-uri", "form-action", "upgrade-insecure-requests", "block-all-mixed-content", "sandbox",
  "report-uri", "report-to", "require-trusted-types-for", "trusted-types",
]);

export function extrasOf(site: Pick<Site, "devFilesAllowed" | "siteCsp"> & { hosting?: string }): SiteExtras {
  return {
    devFilesAllowed: (site.devFilesAllowed ?? "").split("\n").filter(Boolean),
    siteCsp: site.siteCsp || null,
    hosting: site.hosting === "php" ? "php" : "pages",
  };
}

/** Règles d'envoi d'un site (exceptions et hébergement), pour classifySitePath. */
export const rulesOf = (extras: SiteExtras) => ({ allow: extras.devFilesAllowed, hosting: extras.hosting });

export async function siteExtras(siteId: string): Promise<SiteExtras> {
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { devFilesAllowed: true, siteCsp: true, hosting: true } });
  return site ? extrasOf(site) : { devFilesAllowed: [], siteCsp: null, hosting: "pages" };
}

/** Exceptions saisies : chemins exacts, normalisés comme les fichiers du site, sans dossier ni joker, sans doublon. */
export function parseAllowList(raw: string[]): { ok: true; value: string[] } | { ok: false; reason: string } {
  const lines = raw.map((l) => l.trim().replace(/^\/+/, "")).filter(Boolean);
  if (lines.length > MAX_ALLOWED_PATHS) return { ok: false, reason: `${MAX_ALLOWED_PATHS} exceptions au plus.` };
  const out: string[] = [];
  for (const line of lines) {
    if (line.endsWith("/") || /[*?[\]]/.test(line)) return { ok: false, reason: `« ${line.slice(0, 80)} » : chemin exact d'un fichier attendu (ni dossier, ni joker).` };
    const checked = normalizeSitePath(line);
    if (!checked.ok) return { ok: false, reason: `« ${line.slice(0, 80)} » : ${checked.reason}` };
    if (!out.includes(checked.path)) out.push(checked.path);
  }
  return { ok: true, value: out };
}

/**
 * CSP saisie : une seule ligne, directives connues « nom valeurs ; ... », sans guillemet double (écrite entre
 * guillemets dans le .htaccess), antislash ni caractère de contrôle. Vide : null.
 */
export function parseSiteCsp(raw: string | null): { ok: true; value: string | null } | { ok: false; reason: string } {
  const text = (raw ?? "").trim();
  if (!text) return { ok: true, value: null };
  if (/[\r\n]/.test(text)) return { ok: false, reason: "CSP refusée : sur une seule ligne, sans saut de ligne." };
  if (text.length > MAX_CSP_LENGTH) return { ok: false, reason: `CSP trop longue (${MAX_CSP_LENGTH} caractères au plus).` };
  if (/["\\\u0000-\u001f\u007f]/.test(text)) return { ok: false, reason: "CSP refusée : ni guillemet double, ni antislash, ni caractère de contrôle." };
  const directives = text
    .replace(/[ \t]+/g, " ")
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);
  const unknown = directives.map((d) => d.split(" ")[0]!.toLowerCase()).find((name) => !CSP_DIRECTIVES.has(name));
  if (!directives.length || unknown !== undefined) {
    const which = unknown ? ` (directive inconnue : « ${unknown.slice(0, 40)} »)` : "";
    return { ok: false, reason: `CSP invalide${which} : directives de la forme « default-src 'self'; img-src 'self' data: ».` };
  }
  return { ok: true, value: directives.join("; ") };
}

export async function saveSiteExtras(siteId: string, patch: Partial<SiteExtras>): Promise<SiteExtras> {
  const site = await prisma.site.update({
    where: { id: siteId },
    data: {
      ...(patch.devFilesAllowed !== undefined ? { devFilesAllowed: patch.devFilesAllowed.length ? patch.devFilesAllowed.join("\n") : null } : {}),
      ...(patch.siteCsp !== undefined ? { siteCsp: patch.siteCsp } : {}),
    },
    select: { devFilesAllowed: true, siteCsp: true },
  });
  return extrasOf(site);
}
