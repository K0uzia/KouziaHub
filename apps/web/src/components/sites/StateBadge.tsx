import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { SiteSummary } from "@hub/contract";
import { Badge } from "@/components/ui/Card";
import { displayState } from "@/lib/sites";

/** État unique d'un site (priorité de displayState) en texte + icône (la couleur ne porte jamais seule l'information). */
export function StateBadge({
  site,
  className = "",
}: {
  site: Pick<SiteSummary, "state" | "operation" | "domainStatus"> & Partial<Pick<SiteSummary, "monitor">>;
  className?: string;
}) {
  const s = displayState(site);
  return (
    <Badge tone={s.tone} className={className}>
      <FontAwesomeIcon icon={s.icon} className="h-3 w-3" aria-hidden />
      {s.label}
    </Badge>
  );
}

/** Étiquette « Perso » ou nom du client (ERP). */
export function OwnerLabel({ site, wrap = false }: { site: Pick<SiteSummary, "kind" | "clientName">; wrap?: boolean }) {
  if (site.kind === "PERSO") return <Badge tone="violet">Perso</Badge>;
  return site.clientName ? (
    <span className={wrap ? "break-words" : "truncate"}>{site.clientName}</span>
  ) : (
    <span className="text-[var(--muted)]">Client non lu (ERP indisponible)</span>
  );
}
