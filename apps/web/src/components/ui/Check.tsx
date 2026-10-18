import { useId, type ReactNode } from "react";

/** Case à cocher avec libellé et aide : toute la ligne est cliquable, cible de 44 px. */
export function Check({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label className={`flex min-h-11 items-start gap-1 text-sm ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
      <span className="grid h-11 w-11 shrink-0 place-items-center">
        <input
          type="checkbox"
          className="ui-check"
          checked={checked}
          disabled={disabled}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(e) => onChange(e.target.checked)}
        />
      </span>
      <span className="min-w-0 py-2.5">
        <span className="block text-[var(--text)]">{label}</span>
        {hint ? (
          <span id={`${id}-hint`} className="mt-0.5 block text-xs text-[var(--muted)]">
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
}
