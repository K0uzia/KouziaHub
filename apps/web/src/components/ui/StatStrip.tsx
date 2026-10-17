import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export type StatItem = {
  label: string;
  /** Libellé court sous 1280 px (cases étroites) ; le libellé complet reste lu par les lecteurs d'écran. */
  shortLabel?: string;
  value: ReactNode;
  /** Ligne secondaire (contexte, échéance). */
  hint?: ReactNode;
  tone?: "default" | "primary" | "success" | "warning" | "danger";
  /** Écran détaillé : la case devient un lien. */
  to?: string;
};

const toneClass: Record<NonNullable<StatItem["tone"]>, string> = {
  default: "text-[var(--text)]",
  primary: "text-[var(--primary)]",
  success: "text-[var(--success)]",
  warning: "text-[var(--warning)]",
  danger: "text-[var(--danger)]",
};

const cols: Record<number, string> = {
  2: "grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
  5: "grid-cols-2 lg:grid-cols-5",
  6: "grid-cols-2 sm:grid-cols-3 2xl:grid-cols-6",
  7: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-7",
};

/** Mode dense sous 640 px : une seule rangée. */
const denseCols: Record<number, string> = {
  3: "max-sm:grid-cols-3",
  4: "max-sm:grid-cols-4",
  5: "max-lg:grid-cols-5",
};

/** Dernière case d'un nombre impair : elle comble la ligne (2, 3 puis 4 colonnes), sans case vide. */
const lastSpan: Record<number, string> = {
  5: "col-span-2 lg:col-span-1",
  7: "col-span-2 sm:col-span-3 lg:col-span-2 2xl:col-span-1",
};

/** Bandeau d'indicateurs dans une seule carte ; les filets sont l'espace d'1 px entre cases. */
/** busy : valeurs en cours de chargement (squelettes), annoncé aux lecteurs d'écran. */
/** dense : sous 640 px, toutes les cases sur une rangée basse (chiffre au-dessus, libellé court dessous). */
export function StatStrip({
  items,
  className = "",
  busy = false,
  dense = false,
}: {
  items: StatItem[];
  className?: string;
  busy?: boolean;
  dense?: boolean;
}) {
  return (
    <dl
      aria-busy={busy || undefined}
      className={`ui-card grid gap-px overflow-hidden bg-[var(--border)] ${cols[items.length] ?? cols[4]} ${dense ? (denseCols[items.length] ?? "") : ""} ${className}`}
    >
      {items.map((s, i) => {
        // Nombre impair sur 2 colonnes (téléphone) : la dernière case prend toute la largeur, sans vide.
        const lastOdd = i === items.length - 1 && items.length % 2 === 1 && items.length > 1;
        const content = (
          <>
            <dt className={`truncate text-xs font-medium text-[var(--muted)] sm:text-sm ${dense ? "max-sm:whitespace-normal max-sm:text-[length:var(--text-tab)] max-sm:leading-tight" : ""}`}>
              {s.shortLabel ? (
                <>
                  <span aria-hidden className="hidden max-xl:inline">
                    {s.shortLabel}
                  </span>
                  <span className="max-xl:sr-only">{s.label}</span>
                </>
              ) : (
                s.label
              )}
            </dt>
            <dd
              className={`mt-1.5 ${dense ? "max-sm:mt-0 max-sm:mb-1 max-sm:whitespace-nowrap max-sm:text-base max-sm:leading-tight" : ""} font-display text-xl font-semibold tabular-nums tracking-tight sm:text-2xl ${toneClass[s.tone ?? "default"]}`}
            >
              {s.to ? (
                // Lien étiré : son ::after couvre toute la case, la structure dt/dd reste valide.
                <Link
                  to={s.to}
                  // Nom complet : le montant seul ne dit pas où mène le lien.
                  aria-label={typeof s.value === "string" || typeof s.value === "number" ? `${s.label} : ${s.value}` : undefined}
                  className="-my-2 inline-flex min-h-11 min-w-11 items-center sm:-my-1.5 after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-[inherit] focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-[var(--primary)]"
                >
                  {s.value}
                </Link>
              ) : (
                s.value
              )}
            </dd>
            {s.hint ? <dd className={`mt-1 text-xs text-[var(--muted)] ${dense ? "max-sm:hidden" : ""}`}>{s.hint}</dd> : null}
          </>
        );
        return (
          <div
            key={s.label}
            className={`relative min-w-0 bg-[var(--surface)] p-4 sm:p-5 ${dense ? "max-sm:flex max-sm:flex-col-reverse max-sm:justify-end max-sm:px-1 max-sm:py-2.5 max-sm:text-center" : ""} ${lastOdd ? `${lastSpan[items.length] ?? "col-span-2 sm:col-span-1"} ${dense ? "max-lg:col-span-1" : ""}` : ""} ${s.to ? "transition-colors hover:bg-[var(--surface-raised)]" : ""}`}
          >
            {content}
          </div>
        );
      })}
    </dl>
  );
}
