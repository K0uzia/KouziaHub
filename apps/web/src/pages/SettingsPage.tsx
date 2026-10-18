import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useTitle } from "@/lib/useTitle";
import { PageHeader } from "@/components/ui/Card";
import { SecuritySection } from "@/components/settings/SecuritySection";
import { NotificationsSection } from "@/components/settings/NotificationsSection";
import { ControlsSection } from "@/components/settings/ControlsSection";
import { AuditSection } from "@/components/settings/AuditSection";
import { StorageSection } from "@/components/settings/StorageSection";

const SECTIONS = [
  { id: "securite", label: "Sécurité" },
  { id: "notifications", label: "Notifications" },
  { id: "controles", label: "Contrôles" },
  { id: "stockage", label: "Stockage" },
  { id: "journal", label: "Journal" },
];

export function SettingsPage() {
  useTitle("Réglages");
  const { hash } = useLocation();

  // Arrivée par un lien vers une section (#controles depuis le bandeau des orphelins).
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    if (el) requestAnimationFrame(() => el.scrollIntoView({ block: "start" }));
  }, [hash]);

  return (
    <div className="page-narrow">
      <PageHeader title="Réglages" subtitle="Sécurité du compte, notifications, état des services, place utilisée et journal des actions." />
      <nav aria-label="Sections des réglages" className="mb-6">
        <ul className="flex flex-wrap gap-2">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                className="inline-flex min-h-11 items-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 text-sm text-[var(--muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)]"
              >
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="space-y-8">
        <SecuritySection />
        <NotificationsSection />
        <ControlsSection />
        <StorageSection />
        <AuditSection />
      </div>
    </div>
  );
}
