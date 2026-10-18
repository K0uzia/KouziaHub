import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import type { SystemStatus } from "@hub/contract";
import { useResource } from "@/lib/useResource";
import { useTitle } from "@/lib/useTitle";
import { PageHeader } from "@/components/ui/Card";
import { SecuritySection } from "@/components/settings/SecuritySection";
import { NotificationsSection } from "@/components/settings/NotificationsSection";
import { CloudflareTile, ErpTile } from "@/components/settings/ControlsSection";
import { StorageSection } from "@/components/settings/StorageSection";
import { VeilleTile } from "@/components/settings/VeilleTile";
import { AuditSection } from "@/components/settings/AuditSection";

/**
 * Réglages du hub en grille bento : une tuile par sujet, avec son état (Configuré, À faire, Erreur), ses actions
 * principales, et le détail long dans un dépliant ou une modale.
 */
export function SettingsPage() {
  useTitle("Réglages");
  const { hash } = useLocation();
  const system = useResource<SystemStatus>("/api/system");

  // Arrivée par un lien vers une tuile (#controles depuis le bandeau des orphelins, #notifications).
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    if (el) requestAnimationFrame(() => el.scrollIntoView({ block: "start" }));
  }, [hash]);

  return (
    <>
      <PageHeader title="Réglages" subtitle="Sécurité du compte, notifications, services, place utilisée et journal des actions." />
      <div className="bento bento-wide">
        <SecuritySection />
        <NotificationsSection />
        <CloudflareTile system={system} />
        <ErpTile system={system} />
        <VeilleTile />
        <StorageSection />
        <AuditSection />
      </div>
    </>
  );
}
