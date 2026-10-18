import type { RefObject } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronLeft, faChevronRight } from "@fortawesome/free-solid-svg-icons";
import { Button } from "@/components/ui/Button";

/** Nombre de pages d'une liste paginée (au moins 1). */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

/**
 * Pagination d'une liste paginée côté serveur (N1) : Précédent, « page X sur Y » annoncé poliment, Suivant.
 * Boutons de 44 px, désactivés aux bornes. Après un changement, le focus va au haut de la liste (focusRef),
 * pour que le clavier et le lecteur d'écran repartent du début de la nouvelle page.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onChange,
  label,
  focusRef,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  /** Nom de la navigation (« Pages du journal »). */
  label: string;
  focusRef?: RefObject<HTMLElement | null>;
}) {
  const pages = pageCount(total, pageSize);
  if (pages <= 1 && page <= 1) return null;

  function go(next: number) {
    onChange(next);
    requestAnimationFrame(() => focusRef?.current?.focus());
  }

  return (
    <nav aria-label={label} className="flex flex-wrap items-center justify-between gap-2">
      <Button variant="secondary" onClick={() => go(page - 1)} disabled={page <= 1}>
        <FontAwesomeIcon icon={faChevronLeft} className="h-3 w-3" aria-hidden />
        Précédent
      </Button>
      <p className="text-sm text-[var(--muted)]" aria-live="polite">
        Page <span className="font-semibold text-[var(--text)]">{page}</span> sur {pages}
      </p>
      <Button variant="secondary" onClick={() => go(page + 1)} disabled={page >= pages}>
        Suivant
        <FontAwesomeIcon icon={faChevronRight} className="h-3 w-3" aria-hidden />
      </Button>
    </nav>
  );
}
