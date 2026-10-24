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
