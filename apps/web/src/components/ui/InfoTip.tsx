import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircleQuestion } from "@fortawesome/free-solid-svg-icons";
import { GLOSSARY, type GlossaryKey } from "@/lib/glossary";

/** Écart entre le bouton et la bulle, et marge minimale au bord de l'écran (px, mesures du positionnement). */
const GAP = 6;
const EDGE = 8;

/**
 * Explication d'un terme (motif « toggletip ») : bouton « ? » ouvert au clic, à Entrée ou à Espace, jamais
 * au survol seul. La bulle est la description du bouton (aria-describedby), lue aussi bulle fermée.
 * Échap la ferme et rend le focus au bouton ; clic ailleurs ou focus parti ailleurs la ferment aussi.
 * Bulle en portail, en position fixe calée sur le bouton : jamais coupée par une carte ni hors de l'écran.
 */
export function InfoTip({ term, children }: { term: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const bubbleId = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setPlace(null);
    if (refocus) buttonRef.current?.focus();
  }, []);

  // Sous le bouton, centrée et ramenée dans l'écran ; au-dessus s'il manque la place en bas.
  const measure = useCallback(() => {
    const button = buttonRef.current;
    const bubble = bubbleRef.current;
    if (!button || !bubble) return;
    const r = button.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    const left = Math.min(Math.max(EDGE, r.left + r.width / 2 - w / 2), vw - w - EDGE);
    const up = r.bottom + GAP + h > vh - EDGE && r.top - GAP - h >= EDGE;
    setPlace({ top: up ? r.top - GAP - h : r.bottom + GAP, left });
  }, []);

  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => t instanceof Node && (buttonRef.current?.contains(t) || bubbleRef.current?.contains(t));
    const onPointer = (e: PointerEvent) => {
      if (!inside(e.target)) close(false);
    };
    // Échap pris en capture et arrêté : il ferme la bulle seule, jamais la modale qui la contient.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }
    };
    const onFocus = (e: FocusEvent) => {
      if (!inside(e.target)) close(false);
    };
    // Défilement d'un conteneur ou redimensionnement : la bulle suit son bouton.
    const onMove = () => measure();
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, close, measure]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="info-tip"
        aria-label={`Explication : ${term}`}
        aria-expanded={open}
        aria-describedby={bubbleId}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <FontAwesomeIcon icon={faCircleQuestion} className="h-3.5 w-3.5" aria-hidden />
      </button>
      {createPortal(
        <div
          ref={bubbleRef}
          id={bubbleId}
          role="tooltip"
          className="info-tip-bubble"
          hidden={!open}
          style={place ? { top: place.top, left: place.left } : { visibility: "hidden" }}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Explication d'un terme du glossaire de la surveillance. */
export function Explain({ k }: { k: GlossaryKey }) {
  return <InfoTip term={GLOSSARY[k].term}>{GLOSSARY[k].text}</InfoTip>;
}
