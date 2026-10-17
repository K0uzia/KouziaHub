import { Children, cloneElement, isValidElement, useId } from "react";
import type { ComponentPropsWithRef, SelectHTMLAttributes, TextareaHTMLAttributes, ReactNode } from "react";

export function Field({
  label,
  hint,
  error,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const noteId = hint || error ? `${id}-note` : undefined;
  // Aide et erreur : description du contrôle (aria-describedby), pas une partie de son nom.
  // aria-hidden les retire du nom calculé depuis le label ; la référence par id reste lue.
  const describedChild =
    noteId && Children.count(children) === 1 && isValidElement<Record<string, unknown>>(children)
      ? cloneElement(children, {
          "aria-describedby": children.props["aria-describedby"] ?? noteId,
          ...(error ? { "aria-invalid": true } : {}),
        })
      : children;
  const linked = describedChild !== children;
  return (
    <label className={`block min-w-0 space-y-1.5 ${className}`}>
      <span className="block text-sm font-medium text-[var(--text)]">{label}</span>
      {describedChild}
      {hint && !error ? (
        <span id={noteId} aria-hidden={linked || undefined} className="block text-xs text-[var(--muted)]">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={noteId} aria-hidden={linked || undefined} className="block text-sm text-[var(--danger)]">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export const inputClass =
  "w-full min-h-11 rounded-[var(--radius)] border border-[var(--border-input)] bg-[var(--surface-raised)] px-3 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--muted)] transition focus:border-[var(--primary)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/20 disabled:bg-[var(--bg-subtle)] disabled:opacity-70";

// React 19 : ref est une prop ordinaire, transmise avec le reste (focus programmatique).
export function Input({ className = "", ...props }: ComponentPropsWithRef<"input">) {
  return <input className={`${inputClass} ${className}`} {...props} />;
}

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${inputClass} ${className}`} {...props} />;
}

export function Textarea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${inputClass} min-h-24 resize-y ${className}`} {...props} />;
}
