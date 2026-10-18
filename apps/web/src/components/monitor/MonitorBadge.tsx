import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { SiteMonitorBadge } from "@hub/contract";
import { Badge } from "@/components/ui/Card";
import { faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import { badgeLook, EXPIRY_WARN_DAYS, formatUptime } from "@/lib/monitor";

/**
 * État de surveillance d'un site (catalogue) : texte + icône. Sobre sauf en panne (teinte d'alerte).
 * « Non surveillé » reste discret, sans teinte.
 */
export function MonitorBadge({ monitor, withUptime = false }: { monitor: SiteMonitorBadge | null; withUptime?: boolean }) {
  const look = badgeLook(monitor);
  const uptime = withUptime && monitor?.watched ? formatUptime(monitor.uptime30d) : null;
  // Certificat ou domaine sous 30 jours : avertissement à côté de l'état (texte et icône).
  const days = monitor?.watched ? monitor.expiresInDays : null;
  const expiry =
    days != null && days <= EXPIRY_WARN_DAYS ? (
      <Badge tone="amber">
        <FontAwesomeIcon icon={faTriangleExclamation} className="h-3 w-3" aria-hidden />
        {days <= 0 ? "Échéance dépassée" : `Échéance dans ${days} j`}
      </Badge>
    ) : null;
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
      {expiry}
      {uptime ? <span className="text-xs text-[var(--muted)]">{uptime} sur 30 jours</span> : null}
    </span>
  );
}
