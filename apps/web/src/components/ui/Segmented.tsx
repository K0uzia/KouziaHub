/** Choix exclusif compact (période, vue, dimension d'un filtre à 2 à 4 valeurs) : groupe de boutons à bascule. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className = "",
  wrap = false,
  fieldHeight = false,
  disabled = false,
  describedBy,
}: {
  /** count : nombre d'éléments de la valeur (filtre d'une liste), affiché après le libellé. */
  options: ReadonlyArray<{ id: T; label: string; count?: number | null }>;
  value: T;
  onChange: (id: T) => void;
  label: string;
  className?: string;
  /** Plus de trois choix : grille de deux colonnes au téléphone, en ligne à partir de 640 px. */
  wrap?: boolean;
  /** Dès 768 px, même hauteur hors tout qu'un champ (44 px) quand il est aligné avec des champs : boutons de 42 px, sans marge. */
  fieldHeight?: boolean;
  /** Choix indisponible pour l'instant ; describedBy : id du texte qui dit pourquoi. */
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
      className={`${wrap ? "grid grid-cols-2 sm:inline-flex" : "inline-flex"} rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] p-1 ${fieldHeight ? "md:p-0" : ""} ${className}`}
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(o.id)}
            className={`inline-flex min-h-11 ${fieldHeight ? "md:min-h-[2.625rem]" : ""} flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-[calc(var(--radius-sm)-0.125rem)] px-3 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              active
                ? "bg-[var(--surface-hover)] font-medium text-[var(--text)] shadow-[inset_0_0_0_1px_var(--primary)]"
                : "text-[var(--muted)] hover:text-[var(--text)]"
            }`}
          >
            {o.label}
            {o.count != null ? <span className="text-xs tabular-nums opacity-80">{o.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
