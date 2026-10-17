import { useEffect } from "react";

/** Titre de l'onglet : « Écran · Kouzia Hub ». */
export function useTitle(title: string | null | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · Kouzia Hub` : "Kouzia Hub";
  }, [title]);
}
