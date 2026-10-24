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
