/** Monogramme Kouzia (même tracé que l'ERP), décoratif : le nom est toujours écrit à côté ou porté par le lien. */
export function BrandMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={`shrink-0 ${className}`} aria-hidden>
      <rect width="32" height="32" rx="7" fill="var(--surface-raised)" />
      <path d="M10 7v18M10 17l9-10M13 14l7 11" stroke="var(--primary)" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}
