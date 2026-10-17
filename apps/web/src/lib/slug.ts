/** Longueur maximale d'un sous-domaine proposé (le serveur reste seul juge, via slug-check). */
const MAX_SLUG = 40;

/** Sous-domaine proposé depuis un nom : minuscules, sans accent, tirets, rien d'autre. */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " et ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
}

/** Saisie libre du sous-domaine : on garde ce qui peut l'être, sans réécrire la frappe en cours. */
export function cleanSlugInput(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 63);
}
