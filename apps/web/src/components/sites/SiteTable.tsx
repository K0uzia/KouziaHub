import { Link } from "react-router-dom";
import type { SiteSummary } from "@hub/contract";
import { formatAgo, formatDateTime } from "@/lib/format";
import { OwnerLabel, StateBadge } from "@/components/sites/StateBadge";

/** Vue liste du catalogue : tableau natif (cartes empilées sous 768 px), pour chercher et comparer. */
export function SiteTable({ sites }: { sites: SiteSummary[] }) {
  return (
    <div className="ui-card ui-table-wrap max-md:border-0 max-md:bg-transparent max-md:shadow-none">
      <table className="ui-table ui-table-stack">
        <caption className="sr-only">Sites, {sites.length} affichés</caption>
        <thead>
          <tr>
            <th scope="col">Site</th>
            <th scope="col">Client</th>
            <th scope="col">État</th>
            <th scope="col">Version servie</th>
            <th scope="col">Modifié</th>
          </tr>
        </thead>
        <tbody>
          {sites.map((site) => (
            <tr key={site.id}>
              <td data-label="Site" className="wrap">
                <div className="min-w-0">
                  <Link to={`/sites/${site.id}`} className="link font-medium">
                    {site.name}
                  </Link>
                  <span className="block truncate font-mono text-xs text-[var(--muted)]">{site.hostname}</span>
                </div>
              </td>
              <td data-label="Client" className="wrap">
                <OwnerLabel site={site} />
              </td>
              <td data-label="État" className="nowrap">
                <StateBadge site={site} />
              </td>
              <td data-label="Version servie" className="nowrap">
                {site.currentVersion ? (
                  <span>
                    Version {site.currentVersion.number}
                    {site.workingDirty ? <span className="block text-xs text-[var(--warning)]">Modifications non publiées</span> : null}
                  </span>
                ) : (
                  <span className="text-[var(--muted)]">Aucune</span>
                )}
              </td>
              <td data-label="Modifié" className="nowrap">
                <time dateTime={site.touchedAt} title={formatDateTime(site.touchedAt)}>
                  {formatAgo(site.touchedAt)}
                </time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
