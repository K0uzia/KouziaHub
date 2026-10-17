/**
 * Interrupteur (motif ARIA switch) : bouton role="switch" avec aria-checked, libellé visible à côté,
 * état aussi dit en texte (« En ligne » / « Hors ligne ») et pas seulement par la position ou la couleur.
 */
export function Switch({
  checked,
  onChange,
  label,
  stateLabels,
  disabled = false,
  describedBy,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  stateLabels: { on: string; off: string };
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group flex min-h-11 w-full items-center justify-between gap-3 rounded-[var(--radius-sm)] text-left disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-[var(--text)]">{label}</span>
        <span className={`block text-sm ${checked ? "text-[var(--success)]" : "text-[var(--muted)]"}`}>
          {checked ? stateLabels.on : stateLabels.off}
        </span>
      </span>
      <span
        aria-hidden
        className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors duration-150 ${
          checked
            ? "border-[var(--success)] bg-[var(--success-soft)]"
            : "border-[var(--border-input)] bg-[var(--surface-raised)]"
        }`}
      >
        <span
          className={`absolute left-1 h-5 w-5 rounded-full transition-transform duration-150 ease-[var(--ease)] ${
            checked ? "translate-x-5 bg-[var(--success)]" : "translate-x-0 bg-[var(--muted)]"
          }`}
        />
      </span>
    </button>
  );
}
