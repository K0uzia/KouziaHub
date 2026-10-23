import { useId } from "react";
import { THUMBNAIL_FOCUS, type ThumbnailFocus } from "@hub/contract";
import { FOCUS_LABEL } from "@/lib/thumbFrame";

/**
 * Point d'intérêt d'une image qui remplit le cadre : neuf boutons radio natifs en grille 3 x 3 (flèches du clavier),
 * nom de chaque position lu par les lecteurs d'écran, position choisie écrite en clair dessous.
 */
export function FocusPicker({ value, onChange, disabled = false }: { value: ThumbnailFocus; onChange: (f: ThumbnailFocus) => void; disabled?: boolean }) {
  const name = useId();
  return (
    <fieldset disabled={disabled} className="min-w-0 disabled:opacity-60">
      <legend className="text-sm font-medium text-[var(--text)]">Point d'intérêt</legend>
      <div className="mt-2 grid w-max grid-cols-3 gap-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] p-1">
        {THUMBNAIL_FOCUS.map((f) => (
          <label key={f} title={FOCUS_LABEL[f]} className="focus-cell">
            <input type="radio" name={name} value={f} checked={value === f} onChange={() => onChange(f)} className="sr-only" />
            <span className="sr-only">{FOCUS_LABEL[f]}</span>
            <span className="focus-dot" aria-hidden />
          </label>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-[var(--muted)]">{FOCUS_LABEL[value]}</p>
    </fieldset>
  );
}
