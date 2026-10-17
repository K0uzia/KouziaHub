import { useEffect, useId, useRef, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faXmark } from "@fortawesome/free-solid-svg-icons";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Barre d'actions collée en bas du corps de la modale (le corps n'a pas de padding bas : rien ne dépasse sous elle). */
export function ModalActions({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-5 mt-4 flex flex-wrap justify-end gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:-mx-6 sm:px-6 sm:py-4 [&>*]:flex-[1_1_8rem] sm:[&>*]:flex-none">
      {children}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide = false,
  extraWide = false,
  fullScreenMobile = false,
  side = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Dès 1024 px : formulaire et panneau voisin (aperçu du document). */
  extraWide?: boolean;
  /** Sous 640 px : plein écran (formulaire long saisi au téléphone), feuille du bas sinon. */
  fullScreenMobile?: boolean;
  /** Panneau latéral : bord droit sur toute la hauteur dès 640 px, plein écran en dessous (publication du site). */
  side?: boolean;
}) {
  const full = fullScreenMobile || side;
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  // onClose change à chaque rendu chez la plupart des appelants : lu via ref pour ne pas
  // relancer l'effet (et voler le focus) à chaque frappe.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(
      `[autofocus], .modal-body ${FOCUSABLE.split(", ").join(", .modal-body ")}`,
    );
    (first ?? panel)?.focus();

    const onKey = (e: KeyboardEvent) => {
      // Modale ouverte par-dessus une autre (aperçu plein écran) : seule la plus haute réagit.
      const panels = document.querySelectorAll("[data-modal-panel]");
      if (panel && panels[panels.length - 1] !== panel) return;
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) return;
      const head = items[0];
      const tail = items[items.length - 1];
      if (e.shiftKey && document.activeElement === head) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && document.activeElement === tail) {
        e.preventDefault();
        head.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      // Une modale reste ouverte dessous : la page derrière ne défile toujours pas.
      document.body.style.overflow = document.querySelector("[data-modal-panel]") ? "hidden" : "";
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className={`fixed inset-0 z-50 flex items-end justify-center ${side ? "sm:items-stretch sm:justify-end" : "sm:items-center sm:p-6"}`}>
      <button
        type="button"
        aria-label="Fermer"
        tabIndex={-1}
        className="absolute inset-0 bg-[var(--bg)]/75"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        data-modal-panel
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={`relative z-10 flex focus:outline-none w-full min-w-0 flex-col overflow-hidden border-[var(--border)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow)] ${
          side
            ? "h-dvh max-h-dvh rounded-none border-0 sm:max-w-md sm:border-l"
            : `sm:max-h-[92vh] sm:rounded-[var(--radius-lg)] sm:border ${
                fullScreenMobile ? "h-dvh max-h-dvh rounded-none border-0 sm:h-auto" : "max-h-[92vh] rounded-t-[var(--radius-lg)] border"
              } ${extraWide ? "sm:max-w-3xl lg:max-w-6xl" : wide ? "sm:max-w-3xl" : "sm:max-w-lg"}`
        }`}
      >
        {full ? null : (
          <div className="flex h-10 shrink-0 items-center justify-center sm:hidden" aria-hidden>
            <div className="h-1 w-10 rounded-full bg-[var(--muted)]/40" />
          </div>
        )}
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-3 sm:px-6 sm:py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold tracking-tight">
              {title}
            </h2>
            {description ? (
              <p id={descId} className="mt-1 text-sm text-[var(--muted)]">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="inline-flex min-h-11 min-w-11 shrink-0 touch-manipulation items-center justify-center rounded-[var(--radius-sm)] text-[var(--muted)] hover:bg-[var(--bg)] hover:text-[var(--text)]"
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </header>
        <div className="modal-body min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-5 after:block after:h-5 after:content-[''] sm:px-6">
          {children}
        </div>
        {footer ? (
          <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
