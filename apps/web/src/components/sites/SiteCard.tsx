import { Link } from "react-router-dom";
import type { SiteSummary } from "@hub/contract";
import { formatAgo, formatDateTime } from "@/lib/format";
import { OwnerLabel, StateBadge } from "@/components/sites/StateBadge";
import { SiteThumb } from "@/components/sites/SiteThumb";
import { siteFrame } from "@/lib/thumbFrame";
import { ExpiryBadge } from "@/components/monitor/MonitorBadge";
import { isDown } from "@/lib/sites";

/**
 * Carte du catalogue : la carte entière mène à la fiche (lien étiré depuis le titre, nom accessible court),
 * aucune action destructrice dessus.
 */
export function SiteCard({ site, headingLevel = 3 }: { site: SiteSummary; headingLevel?: 2 | 3 }) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const version = site.currentVersion;
  return (
    <article className="site-card group" data-down={isDown(site) || undefined}>
      <SiteThumb src={site.thumbnailUrl} frame={siteFrame(site)} className="rounded-t-[calc(var(--radius-lg)-1px)]" />
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-4">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <Heading className="min-w-0 text-base font-semibold leading-snug text-[var(--text)]">
            <Link to={`/sites/${site.id}`} className="site-card-link break-words">
              {site.name}
            </Link>
          </Heading>
        </div>
        {/* Nom du site = nom du client : la ligne du client le répéterait. */}
        {site.kind === "CLIENT" && site.clientName === site.name ? null : (
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-[var(--text)]">
            <OwnerLabel site={site} />
          </div>
        )}
        {/* Un seul état (panne, erreur, création, hors ligne, en ligne) ; l'échéance proche reste à côté, en petit. */}
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge site={site} />
          <ExpiryBadge monitor={site.monitor} />
        </div>
        <p className="truncate font-mono text-sm text-[var(--muted)]" title={site.hostname}>
          {site.hostname}
        </p>
        <p className="mt-auto text-xs text-[var(--muted)]">
          {version?.publishedAt ? (
            <>
              Version {version.number}, publiée{" "}
              <time dateTime={version.publishedAt} title={formatDateTime(version.publishedAt)}>
                {formatAgo(version.publishedAt)}
              </time>
            </>
          ) : (
            "Aucune version publiée"
          )}
        </p>
      </div>
    </article>
  );
}
