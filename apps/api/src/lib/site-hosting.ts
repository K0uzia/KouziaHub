import type { VersionCheck } from "@/contract.js";

// Hébergement d'un site (docs/cadrage.md, section 11) : « pages » (Cloudflare Pages, statique) ou « php » (CT des
// sites PHP, piloté par son agent). Un site PHP n'a pas de projet Pages.

export type Hosting = "pages" | "php";

export const hostingOf = (site: { hosting: string }): Hosting => (site.hosting === "php" ? "php" : "pages");

/**
 * Projet Pages d'un site Pages. Un site PHP n'en a pas : l'appeler pour lui est une erreur de programmation,
 * signalée ici plutôt que de passer un nom vide à Cloudflare.
 */
export function pagesProjectOf(site: { slug: string; pagesProject: string | null }): string {
  if (!site.pagesProject) throw new Error(`Site ${site.slug} sans projet Cloudflare Pages (site PHP) : opération Pages refusée.`);
  return site.pagesProject;
}

/** Site PHP : une page d'entrée (index.php ou index.html) dans le dossier public, sinon refus sans confirmation. */
export function phpEntryCheck(paths: string[], publicDir: string): VersionCheck | null {
  const prefix = publicDir ? `${publicDir}/` : "";
  if (paths.some((p) => p === `${prefix}index.php` || p === `${prefix}index.html`)) return null;
  return {
    code: "no_index",
    framework: null,
    command: null,
    outDir: null,
    buildScript: null,
    message: `Ni index.php ni index.html dans ${publicDir ? `le dossier public « ${publicDir}/ »` : "la racine"} : le site n'aurait pas de page d'accueil (dossier public réglable dans la fiche).`,
  };
}

/** Fichier lourd : au-delà de 1 Mio. */
export const HEAVY_FILE_BYTES = 1024 * 1024;
/** Code et réglages : jamais signalés (ils servent à PHP même hors du dossier public). */
const CODE_RE = /\.(php\d?|phtml|inc|twig|json|ini|sql|ya?ml|xml|lock|txt|html?|css|m?js|sh)$/i;

export type HeavyGroup = { dir: string; count: number; bytes: number };

/**
 * Site PHP : fichiers lourds jamais servis, groupés par dossier (deux niveaux) : hors du dossier public et des
 * dossiers persistants, ce n'est pas du code. Proposés à l'exclusion (« Ne pas envoyer ») pour alléger l'archive.
 */
export function heavyUnserved(
  files: Array<{ path: string; size: number }>,
  site: { publicDir: string; persistentDirs: string[]; publicPersistentDirs: string[] },
): HeavyGroup[] {
  // Dossier public à la racine : tout est servi, rien à signaler.
  if (!site.publicDir) return [];
  const kept = [`${site.publicDir}/`, ...[...site.persistentDirs, ...site.publicPersistentDirs].map((d) => `${d}/`)];
  const groups = new Map<string, HeavyGroup>();
  for (const f of files) {
    if (f.size <= HEAVY_FILE_BYTES || CODE_RE.test(f.path) || kept.some((k) => f.path.startsWith(k))) continue;
    const segments = f.path.split("/").slice(0, -1);
    if (!segments.length) continue;
    const dir = `${segments.slice(0, 2).join("/")}/`;
    const g = groups.get(dir) ?? { dir, count: 0, bytes: 0 };
    g.count += 1;
    g.bytes += f.size;
    groups.set(dir, g);
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 10);
}
