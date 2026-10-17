import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faEllipsis } from "@fortawesome/free-solid-svg-icons";
import { buttonClass } from "@/components/ui/Button";

export type MoreMenuItem = {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
};

/**
 * Actions secondaires regroupées (motif disclosure) : Échap ou clic extérieur ferment
 * le panneau, le focus revient au déclencheur après Échap ou après un choix.
 */
export function MoreMenu({
  items,
  label = "Plus",
  icon = true,
  variant = "secondary",
  leading,
  ariaLabel,
  compactMobile = false,
  disabled = false,
  describedBy,
}: {
  items: MoreMenuItem[];
  label?: ReactNode;
  icon?: boolean;
  variant?: "primary" | "secondary" | "ghost";
  leading?: ReactNode;
  /** Nom accessible quand le libellé visible est masqué sur petit écran. */
  ariaLabel?: string;
  /** Sous 640 px : bouton carré de 44 px (icône seule, libellé masqué par l'appelant). */
  compactMobile?: boolean;
  /** Déclencheur désactivé (ex. hors ligne) ; describedBy : id du texte qui explique pourquoi. */
  disabled?: boolean;
  describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const visible = items.filter(Boolean);
  if (visible.length === 0) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={buttonClass(variant, `${compactMobile ? "w-full px-0 sm:px-4" : "w-full"} disabled:cursor-not-allowed disabled:opacity-50`)}
      >
        {leading}
        {icon ? <FontAwesomeIcon icon={faEllipsis} className="h-4 w-4" aria-hidden /> : null}
        {label}
      </button>
      {open && !disabled ? (
        <ul
          id={panelId}
          className="absolute right-0 z-30 mt-2 min-w-56 overflow-hidden rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface-raised)] py-1 shadow-[var(--shadow)]"
        >
          {visible.map((item) => (
            <li key={item.label}>
              <button
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                  item.onSelect();
                }}
                className={`flex min-h-11 w-full items-center px-4 text-left text-sm transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50 ${
                  item.danger ? "text-[var(--danger)]" : "text-[var(--text)]"
                }`}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
