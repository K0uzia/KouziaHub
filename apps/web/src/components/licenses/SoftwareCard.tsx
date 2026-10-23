import { Link } from "react-router-dom";
import { faCube } from "@fortawesome/free-solid-svg-icons";
import type { SoftwareSummary } from "@hub/contract";
import { formatDay, plural } from "@/lib/format";
import { SOFTWARE_STATE, stateOf, validCount } from "@/lib/software";
import { Badge } from "@/components/ui/Card";
import { SiteThumb } from "@/components/sites/SiteThumb";
import { softwareFrame } from "@/lib/thumbFrame";

/** Badge d'état d'un logiciel, avec l'échéance proche à côté (même place que sur une carte de site). */
export function SoftwareBadges({ software }: { software: SoftwareSummary }) {
  const state = SOFTWARE_STATE[stateOf(software)];
  const n = software.counts.expiring;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Badge tone={state.tone}>{state.label}</Badge>
      {n ? <Badge tone="amber">{`${n} expire${n > 1 ? "nt" : ""} bientôt`}</Badge> : null}
    </span>
  );
}

/** Prochaine échéance d'une licence en cours, ou rien d'écrit si aucune. */
export function nextExpiryText(s: SoftwareSummary): string {
  return s.nextExpiry ? `Prochaine expiration le ${formatDay(s.nextExpiry.expire)}, ${s.nextExpiry.entreprise}` : "Aucune licence en cours";
}

/**
 * Carte du catalogue des logiciels, sur le modèle des sites : la carte entière mène à la fiche (lien étiré depuis le
 * titre), vignette, état, licences en cours et prochaine expiration.
 */
export function SoftwareCard({ software }: { software: SoftwareSummary }) {
  const valid = validCount(software);
  return (
    <article className="site-card group">
      <SiteThumb src={software.thumbnailUrl} icon={faCube} frame={softwareFrame(software)} className="rounded-t-[calc(var(--radius-lg)-1px)]" />
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-4">
        <h3 className="min-w-0 text-base font-semibold leading-snug text-[var(--text)]">
          <Link to={`/logiciels/${software.slug}`} className="site-card-link break-words">
            {software.name}
          </Link>
        </h3>
        {software.description ? <p className="line-clamp-2 text-sm text-[var(--muted)]">{software.description}</p> : null}
        <SoftwareBadges software={software} />
        <p className="text-sm text-[var(--text)]">
          {valid ? plural(valid, "licence en cours", "licences en cours") : "Aucune licence en cours"}
          {software.counts.expired ? <span className="text-[var(--muted)]">{`, ${plural(software.counts.expired, "expirée", "expirées")}`}</span> : null}
        </p>
        <p className="mt-auto text-xs text-[var(--muted)]">{software.nextExpiry ? nextExpiryText(software) : `Clés ${software.keyPrefix}`}</p>
      </div>
    </article>
  );
}
