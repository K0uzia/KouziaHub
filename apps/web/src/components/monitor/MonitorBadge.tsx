import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { SiteMonitorBadge } from "@hub/contract";
import { Badge } from "@/components/ui/Card";
import { badgeLook, formatUptime } from "@/lib/monitor";

/**
 * État de surveillance d'un site (catalogue) : texte + icône. Sobre sauf en panne (teinte d'alerte).
 * « Non surveillé » reste discret, sans teinte.
 */
export function MonitorBadge({ monitor, withUptime = false }: { monitor: SiteMonitorBadge | null; withUptime?: boolean }) {
  const look = badgeLook(monitor);
  const uptime = withUptime && monitor?.watched ? formatUptime(monitor.uptime30d) : null;
  if (look.tone === "neutral") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-[var(--muted)]">
        <FontAwesomeIcon icon={look.icon} className="h-3 w-3" aria-hidden />
        {look.label}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge tone={look.tone}>
        <FontAwesomeIcon icon={look.icon} className="h-3 w-3" aria-hidden />
        {look.label}
      </Badge>
      {uptime ? <span className="text-xs text-[var(--muted)]">{uptime} sur 30 jours</span> : null}
    </span>
  );
}
