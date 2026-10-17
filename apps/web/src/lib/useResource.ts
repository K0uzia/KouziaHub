import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, isAbort } from "@/lib/api";

export type Resource<T> = {
  data: T | null;
  error: string | null;
  /** Premier chargement (aucune donnée encore). */
  loading: boolean;
  /** Relit la ressource sans vider l'affichage (pas de clignotement). */
  reload: () => Promise<void>;
  /** Remplace la donnée par la réponse d'une action (la vue suit l'état sans relecture). */
  setData: (next: T | ((prev: T | null) => T | null)) => void;
};

/**
 * Lecture d'une route GET. pollMs : relecture périodique tant que la valeur est fournie (null pour arrêter) ;
 * l'appelant la calcule depuis la donnée (opération en cours), elle s'arrête donc d'elle-même.
 */
export function useResource<T>(
  path: string | null,
  pollMs: number | null = null,
  /** keepData : la donnée reste affichée pendant la lecture d'une variante (« Afficher plus »). */
  { keepData = false }: { keepData?: boolean } = {},
): Resource<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const pathRef = useRef(path);
  pathRef.current = path;
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const current = pathRef.current;
    if (!current) return;
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    try {
      const next = await api<T>(current, { signal: ctrl.signal });
      if (ctrl.signal.aborted || pathRef.current !== current) return;
      setDataState(next);
      setError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setError(errorMessage(err, "Lecture impossible. Réessayez."));
    } finally {
      if (controller.current === ctrl) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!keepData) setDataState(null);
    setError(null);
    setLoading(path !== null);
    void load();
    return () => controller.current?.abort();
  }, [path, load, keepData]);

  useEffect(() => {
    if (!pollMs || !path) return;
    const id = window.setInterval(() => void load(), pollMs);
    return () => window.clearInterval(id);
  }, [pollMs, path, load]);

  const setData = useCallback((next: T | ((prev: T | null) => T | null)) => {
    setDataState((prev) => (typeof next === "function" ? (next as (p: T | null) => T | null)(prev) : next));
  }, []);

  return { data, error, loading, reload: load, setData };
}

/** Valeur retardée (contrôle en direct après la frappe). */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Préférence légère gardée dans le navigateur (vue cartes ou liste) ; stockage indisponible : valeur par défaut. */
export function useStoredChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return (allowed as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        window.localStorage.setItem(key, v);
      } catch {
        /* stockage refusé : la préférence vaut pour cette visite */
      }
    },
    [key],
  );
  return [value, set];
}
