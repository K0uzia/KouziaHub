import { Link } from "react-router-dom";
import type { AuditEntry, Page } from "@hub/contract";
import { formatAgo, formatDateTime } from "@/lib/format";
import { actionLabel } from "@/lib/auditLabels";
import { journalStatus } from "@/lib/settingsStatus";
import { useResource } from "@/lib/useResource";
import { Button } from "@/components/ui/Button";
import { Tile } from "@/components/ui/Tile";
import { AuditResult } from "@/pages/AuditPage";

const SHOWN = 5;

/** Jour local (AAAA-MM-JJ) il y a `days` jours. */
function dayAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Tuile Journal : dernières actions et échecs de la semaine ; le journal complet est paginé sur sa page. */
export function AuditSection() {
  const latest = useResource<Page<AuditEntry>>(`/api/audit?pageSize=${SHOWN}`);
  const errors = useResource<Page<AuditEntry>>(`/api/audit?result=error&from=${dayAgo(6)}&pageSize=1`);
  const items = latest.data?.items ?? [];

  return (
    <Tile
      id="journal"
      className="scroll-mt-4"
      title="Journal"
      level={2}
      span={2}
      status={journalStatus({ data: errors.data ? { errorsLastWeek: errors.data.total } : null, error: errors.error })}
    >
      {latest.loading && !latest.data ? (
        <p role="status" className="text-sm text-[var(--muted)]">
          Lecture du journal…
        </p>
      ) : latest.error && !latest.data ? (
        <Button variant="ghost" className="self-start" onClick={() => void latest.reload()}>
          Réessayer
        </Button>
      ) : items.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">Aucune action enregistrée pour l'instant.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)]" aria-label="Dernières actions">
          {items.map((e) => (
            <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5 text-sm">
              <span className="min-w-0">
                <span className="text-[var(--text)]">{actionLabel(e.action) ?? <span className="font-mono text-xs">{e.action}</span>}</span>
                {e.siteSlug ? <span className="ml-2 font-mono text-xs text-[var(--muted)]">{e.siteSlug}</span> : null}
              </span>
              <span className="flex items-baseline gap-3 text-xs text-[var(--muted)]">
                <time dateTime={e.at} title={formatDateTime(e.at)}>
                  {formatAgo(e.at)}
                </time>
                <AuditResult result={e.result} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-x-4">
        <Link to="/reglages/journal" className="link inline-flex min-h-11 items-center text-sm font-medium">
          {latest.data && latest.data.total > SHOWN ? `Journal complet (${latest.data.total} actions)` : "Journal complet"}
        </Link>
        {errors.data && errors.data.total > 0 ? (
          <Link to={`/reglages/journal?resultat=error&du=${dayAgo(6)}`} className="link inline-flex min-h-11 items-center text-sm font-medium">
            Voir les échecs de la semaine
          </Link>
        ) : null}
      </div>
    </Tile>
  );
}
