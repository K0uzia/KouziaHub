import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { SiteMonitorBadge } from "@hub/contract";
import { Badge } from "@/components/ui/Card";
import { faCircleQuestion, faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import { EXPIRY_WARN_DAYS, formatUptime, VERDICT } from "@/lib/monitor";

/** Certificat ou domaine sous 30 jours : petit avertissement (texte et icône), compatible avec tout état. */
export function ExpiryBadge({ monitor }: { monitor: SiteMonitorBadge | null }) {
  const days = monitor?.watched ? monitor.expiresInDays : null;
  if (days == null || days > EXPIRY_WARN_DAYS) return null;
  return (
    <Badge tone="amber">
      <FontAwesomeIcon icon={faTriangleExclamation} className="h-3 w-3" aria-hidden />
      {days <= 0 ? "Échéance dépassée" : `Échéance dans ${days} j`}
    </Badge>
  );
}

/**
 * Colonne Surveillance de la liste : disponibilité, avertissements qui ne sont pas une panne (problème local,
 * vu par Cloudflare seul) et échéance. La panne n'y figure pas : elle est l'état du site (colonne État).
 */
export function MonitorDetails({ monitor }: { monitor: SiteMonitorBadge | null }) {
  if (!monitor || monitor.watched === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-[var(--muted)]">
        <FontAwesomeIcon icon={faCircleQuestion} className="h-3 w-3" aria-hidden />
        Non surveillé
      </span>
    );
  }
  const uptime = formatUptime(monitor.uptime30d);
  const warn = monitor.verdict === "local_only" || monitor.verdict === "edge_only" ? VERDICT[monitor.verdict] : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {warn ? (
        <Badge tone={warn.tone}>
          <FontAwesomeIcon icon={warn.icon} className="h-3 w-3" aria-hidden />
          {warn.short}
        </Badge>
      ) : null}
      <ExpiryBadge monitor={monitor} />
      <span className="text-xs text-[var(--muted)]">{uptime ? `${uptime} sur 30 jours` : "Pas encore de mesure"}</span>
    </span>
  );
}
