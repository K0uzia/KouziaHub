import { Link } from "react-router-dom";
import type { SoftwareSummary } from "@hub/contract";
import { formatDay, plural } from "@/lib/format";
import { validCount } from "@/lib/software";
import { SoftwareBadges } from "@/components/licenses/SoftwareCard";

/** Vue liste du catalogue des logiciels : tableau natif (cartes empilées sous 768 px), comme celui des sites. */
export function SoftwareTable({ software }: { software: SoftwareSummary[] }) {
  return (
    <div className="ui-card ui-table-wrap max-md:border-0 max-md:bg-transparent max-md:shadow-none">
      <table className="ui-table ui-table-stack">
        <caption className="sr-only">Logiciels, {software.length} affichés</caption>
        <thead>
          <tr>
            <th scope="col">Logiciel</th>
            <th scope="col">État</th>
            <th scope="col">Licences en cours</th>
            <th scope="col">Prochaine expiration</th>
          </tr>
        </thead>
        <tbody>
          {software.map((s) => (
            <tr key={s.slug}>
              <td data-label="Logiciel" className="wrap">
                <div className="min-w-0">
                  <Link to={`/logiciels/${s.slug}`} className="link font-medium">
                    {s.name}
                  </Link>
                  <span className="block truncate font-mono text-xs text-[var(--muted)]">
                    {s.slug}, clés {s.keyPrefix}
                  </span>
                </div>
              </td>
              <td data-label="État" className="wrap">
                <SoftwareBadges software={s} />
              </td>
              <td data-label="Licences en cours" className="nowrap">
                {validCount(s) || <span className="text-[var(--muted)]">Aucune</span>}
                {s.counts.expired ? <span className="block text-xs text-[var(--muted)]">{plural(s.counts.expired, "expirée", "expirées")}</span> : null}
              </td>
              <td data-label="Prochaine expiration" className="wrap">
                {s.nextExpiry ? (
                  <span>
                    {formatDay(s.nextExpiry.expire)}
                    <span className="block text-xs text-[var(--muted)]">{s.nextExpiry.entreprise}</span>
                  </span>
                ) : (
                  <span className="text-[var(--muted)]">Aucune</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
