import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faEllipsis } from "@fortawesome/free-solid-svg-icons";
import { buttonClass } from "@/components/ui/Button";

export type MoreMenuItem = {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
};

/** Écart entre le bouton et le menu, et marge minimale au bord de l'écran (px, mesures du positionnement). */
const GAP = 6;
const EDGE = 8;

type Place = { top: number; left: number; up: boolean; maxHeight: number };

/**
 * Actions secondaires regroupées (motif disclosure). Le panneau est rendu dans un portail (fin du body),
 * en position fixe calée sur le bouton : jamais coupé par un overflow (tableau, carte), ouvert vers le
 * haut près du bas de l'écran. Échap, Tab ou clic extérieur ferment ; le focus revient au bouton.
 * Flèches haut et bas, Début et Fin parcourent les choix.
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
  /** Nom accessible quand le libellé visible est masqué. */
  ariaLabel?: string;
  /** Sous 640 px : bouton carré de 44 px (icône seule, libellé masqué par l'appelant). */
  compactMobile?: boolean;
  disabled?: boolean;
  describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLUListElement>(null);
  const viaKeyboard = useRef(false);
  const panelId = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setPlace(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // Position : sous le bouton, aligné à droite ; au-dessus s'il manque la place en bas.
  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const r = trigger.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const h = panel.scrollHeight;
    const w = panel.offsetWidth;
    const below = vh - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const up = h > below && above > below;
    const maxHeight = Math.max(120, up ? above : below);
    const left = Math.min(Math.max(EDGE, r.right - w), vw - w - EDGE);
    const top = up ? r.top - GAP - Math.min(h, maxHeight) : r.bottom + GAP;
    setPlace({ top, left, up, maxHeight });
  }, []);

  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      // Clic ailleurs : le focus suit ce clic, il ne revient au bouton que s'il était dans le menu.
      close(panelRef.current?.contains(document.activeElement) ?? false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      }
    };
    // Focus parti ailleurs (Tab depuis le bouton) : le menu se ferme sans reprendre le focus.
    const onFocus = (e: FocusEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !panelRef.current?.contains(t)) close(false);
    };
    document.addEventListener("focusin", onFocus);
    // Défilement d'un conteneur ou redimensionnement : le menu suit son bouton.
    const onMove = () => measure();
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, close, measure]);

  // Ouvert au clavier : le focus va au premier choix actif.
  useEffect(() => {
    if (!open || !place || !viaKeyboard.current) return;
    viaKeyboard.current = false;
    enabledButtons()[0]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, place]);

  const visible = items.filter(Boolean);
  if (visible.length === 0) return null;

  function enabledButtons(): HTMLButtonElement[] {
    return Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
  }

  function onPanelKey(e: KeyboardEvent<HTMLUListElement>) {
    const list = enabledButtons();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (i + 1) % list.length;
    else if (e.key === "ArrowUp") next = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Tab") {
      // Le panneau est en fin de page : Tab reviendrait au début du document. On referme sur le bouton.
      e.preventDefault();
      close(true);
      return;
    } else return;
    e.preventDefault();
    list[next]?.focus();
  }

  function onTriggerKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const list = enabledButtons();
      if (open && list.length) list[e.key === "ArrowUp" ? list.length - 1 : 0]?.focus();
      else {
        viaKeyboard.current = true;
        setOpen(true);
      }
    }
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={(e) => {
          // Entrée ou Espace : detail vaut 0 (pas de pointeur), le focus ira au premier choix.
          viaKeyboard.current = e.detail === 0;
          if (open) close(false);
          else setOpen(true);
        }}
        onKeyDown={onTriggerKey}
        className={buttonClass(variant, `${compactMobile ? "w-full px-0 sm:px-4" : "w-full"} disabled:cursor-not-allowed disabled:opacity-50`)}
      >
        {leading}
        {icon ? <FontAwesomeIcon icon={faEllipsis} className="h-4 w-4" aria-hidden /> : null}
        {label}
      </button>
      {open && !disabled
        ? createPortal(
            <ul
              ref={panelRef}
              id={panelId}
              onKeyDown={onPanelKey}
              style={
                place
                  ? { top: place.top, left: place.left, maxHeight: place.maxHeight }
                  : { top: 0, left: 0, visibility: "hidden" }
              }
              className="menu-panel"
            >
              {visible.map((item) => (
                <li key={item.label}>
                  <button
                    type="button"
                    disabled={item.disabled}
                    onClick={() => {
                      close(true);
                      item.onSelect();
                    }}
                    className={`flex min-h-11 w-full items-center px-4 text-left text-sm transition-colors hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50 ${
                      item.danger ? "text-[var(--danger)]" : "text-[var(--text)]"
                    }`}
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}
