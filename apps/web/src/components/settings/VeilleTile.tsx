import { Link } from "react-router-dom";
import type { MonitorOverview } from "@hub/contract";
import { formatAgo } from "@/lib/format";
import { veilleStatus } from "@/lib/settingsStatus";
import { useResource } from "@/lib/useResource";
import { Button } from "@/components/ui/Button";
import { Tile } from "@/components/ui/Tile";

/** Tuile Veille : le Worker Cloudflare qui surveille hors de la box (passages, envoi de la configuration). */
export function VeilleTile() {
  const overview = useResource<MonitorOverview>("/api/monitor");
  const edge = overview.data?.health.edge;
  return (
    <Tile title="Veille (Worker)" level={2} tip="worker" status={veilleStatus({ data: overview.data, error: overview.error })}>
      {overview.error && !overview.data ? (
        <Button variant="ghost" className="self-start" onClick={() => void overview.reload()}>
          Réessayer
        </Button>
      ) : edge ? (
        <dl className="space-y-1 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <dt className="text-xs text-[var(--muted)]">Dernier passage</dt>
            <dd>{edge.lastSeenAt ? formatAgo(edge.lastSeenAt) : "aucun"}</dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <dt className="text-xs text-[var(--muted)]">Configuration envoyée</dt>
            <dd>{edge.lastSyncAt ? formatAgo(edge.lastSyncAt) : "jamais"}</dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <dt className="text-xs text-[var(--muted)]">Domaines Cloudflare proposés</dt>
            <dd>{overview.data?.health.zonesToken ? "jeton posé" : "jeton absent (facultatif)"}</dd>
          </div>
        </dl>
      ) : null}
      <Link to="/surveillance" className="link inline-flex min-h-11 items-center self-start text-sm font-medium">
        {overview.data && overview.data.stats.watched === 0 ? "Ajouter une adresse à surveiller" : "Surveillance et marche à suivre"}
      </Link>
    </Tile>
  );
}
