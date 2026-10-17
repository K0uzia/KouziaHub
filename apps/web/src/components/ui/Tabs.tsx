import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";

export type TabDef<T extends string> = { id: T; label: string; count?: number | null };

/** Onglet courant lu et écrit dans `?tab=` : l'onglet survit au rafraîchissement et se partage. */
export function useTabParam<T extends string>(ids: readonly T[], fallback: T): [T, (id: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const current = (ids as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
  const set = (id: T) => {
    const next = new URLSearchParams(params);
    if (id === fallback) next.delete("tab");
    else next.set("tab", id);
    setParams(next, { replace: true });
  };
  return [current, set];
}

/**
 * Onglets (motif ARIA tabs) : flèches gauche/droite, Début, Fin ; un seul onglet dans l'ordre
 * de tabulation. Le panneau associé porte l'id renvoyé par `panelId`.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  children,
}: {
  tabs: ReadonlyArray<TabDef<T>>;
  value: T;
  onChange: (id: T) => void;
  label: string;
  children: ReactNode;
}) {
  const base = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  // Onglet actif toujours visible dans la bande qui défile (arrivée par ?tab=, flèches du clavier).
  // Défilement horizontal de la bande seulement : scrollIntoView ferait aussi défiler la page.
  useEffect(() => {
    const el = refs.current[tabs.findIndex((t) => t.id === value)];
    const list = el?.parentElement;
    if (!el || !list) return;
    const margin = parseFloat(getComputedStyle(list).paddingLeft) || 0;
    if (el.offsetLeft - margin < list.scrollLeft) list.scrollLeft = el.offsetLeft - margin;
    else if (el.offsetLeft + el.offsetWidth + margin > list.scrollLeft + list.clientWidth)
      list.scrollLeft = el.offsetLeft + el.offsetWidth + margin - list.clientWidth;
  }, [tabs, value]);

  function onKey(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    onChange(tabs[next].id);
    refs.current[next]?.focus();
  }

  return (
    <div className="min-w-0">
      <div
        role="tablist"
        aria-label={label}
        // Sous 640 px : bande pleine largeur, bords en fondu (il reste des onglets à faire défiler).
        className="relative -mx-[var(--gutter)] flex snap-x gap-1 overflow-x-auto border-b border-[var(--border)] px-[var(--gutter)] no-scrollbar [mask-image:linear-gradient(to_right,transparent,black_var(--gutter),black_calc(100%-var(--gutter)),transparent)] sm:mx-0 sm:px-0 sm:[mask-image:none]"
      >
        {tabs.map((t, i) => {
          const active = t.id === value;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${t.id}`}
              aria-selected={active}
              aria-controls={`${base}-panel`}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(t.id)}
              onKeyDown={(e) => onKey(e, i)}
              className={`-mb-px inline-flex min-h-11 shrink-0 snap-start scroll-mx-[var(--gutter)] items-center gap-2 border-b-2 px-3 text-sm transition-colors ${
                active
                  ? "border-[var(--primary)] font-medium text-[var(--text)]"
                  : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"
              }`}
            >
              {t.label}
              {t.count != null ? (
                <span className="rounded-full bg-[var(--surface-hover)] px-1.5 text-xs tabular-nums leading-5 text-[var(--muted)]">
                  {t.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${base}-panel`}
        aria-labelledby={`${base}-tab-${value}`}
        tabIndex={0}
        className="pt-5 focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--primary)]"
      >
        {children}
      </div>
    </div>
  );
}
