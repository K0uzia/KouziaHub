import { useSearchParams } from "react-router-dom";

/**
 * Filtres et page d'une liste paginée, gardés dans l'URL (lien partageable, retour arrière du navigateur).
 * Une valeur égale à sa valeur par défaut est retirée de l'URL ; changer un filtre ramène à la page 1.
 * Les valeurs sont validées par le serveur : une valeur refusée affiche son message d'erreur.
 */
export function useUrlList<F extends Record<string, string>>(defaults: F) {
  const [params, setParams] = useSearchParams();
  const keys = Object.keys(defaults) as Array<keyof F & string>;
  const values = Object.fromEntries(keys.map((k) => [k, params.get(k) ?? defaults[k]])) as F;
  const raw = Number(params.get("page"));
  const page = Number.isInteger(raw) && raw >= 1 ? raw : 1;

  function apply(changes: Partial<F>, nextPage: number) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (!v || v === defaults[k]) next.delete(k);
      else next.set(k, String(v));
    }
    if (nextPage > 1) next.set("page", String(nextPage));
    else next.delete("page");
    setParams(next, { replace: true });
  }

  return {
    values,
    page,
    /** Filtres actifs parmi ceux donnés (tous par défaut). */
    isFiltered: (only: Array<keyof F & string> = keys) => only.some((k) => values[k] !== defaults[k]),
    setFilter: (key: keyof F & string, value: string) => apply({ [key]: value } as Partial<F>, 1),
    setPage: (p: number) => apply({}, p),
    clear: (only: Array<keyof F & string> = keys) => apply(Object.fromEntries(only.map((k) => [k, defaults[k]])) as Partial<F>, 1),
  };
}

/** Paramètres de la requête à l'API : seulement les valeurs renseignées. */
export function apiQuery(values: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== "") q.set(k, String(v));
  return q.toString();
}
