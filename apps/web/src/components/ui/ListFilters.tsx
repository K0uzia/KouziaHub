import { useId, type ReactNode } from "react";
import { Segmented } from "./Segmented";
import { Select } from "./Field";

/**
 * Filtres d'une liste, un contrôle par dimension (NN/g « Filters vs. Facets ») : contrôle segmenté pour 2 à 4
 * valeurs exclusives, liste native avec le nombre par valeur au-delà. Libellé visible au-dessus de chaque contrôle.
 */
export type FilterOption<T extends string> = { id: T; label: string; count?: number | null };

/** Rangée des filtres : retour à la ligne au téléphone, alignés sur la ligne de base des champs ensuite. */
export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-wrap items-end gap-3">{children}</div>;
}

export function FilterSegment<T extends string>({
  label,
  value,
  onChange,
  options,
  wrap = false,
  compact = false,
  className = "",
}: {
  label: string;
  value: T;
  onChange: (id: T) => void;
  options: ReadonlyArray<FilterOption<T>>;
  /** Quatre choix : deux colonnes au téléphone. */
  wrap?: boolean;
  /** Libellé masqué au téléphone (colonne étroite) : le groupe garde son nom accessible. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={`min-w-0 space-y-1.5 max-sm:w-full ${className}`}>
      <span className={`block text-sm font-medium text-[var(--text)] ${compact ? "max-sm:sr-only" : ""}`} aria-hidden>
        {label}
      </span>
      <Segmented label={label} options={options} value={value} onChange={onChange} wrap={wrap} fieldHeight className="max-sm:w-full" />
    </div>
  );
}

export function FilterSelect<T extends string>({
  label,
  value,
  onChange,
  options,
  compact = false,
  className = "",
}: {
  label: string;
  value: T;
  onChange: (id: T) => void;
  options: ReadonlyArray<FilterOption<T>>;
  /** Libellé masqué au téléphone ; les options se lisent seules (« Tous les messages »). */
  compact?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={`min-w-0 space-y-1.5 max-sm:w-full sm:w-56 ${className}`}>
      <label htmlFor={id} className={`block text-sm font-medium text-[var(--text)] ${compact ? "max-sm:sr-only" : ""}`}>
        {label}
      </label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value as T)} className="cursor-pointer">
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.count != null ? `${o.label} (${o.count})` : o.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
