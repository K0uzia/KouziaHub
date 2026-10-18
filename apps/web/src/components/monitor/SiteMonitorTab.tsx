import { Link } from "react-router-dom";
import type { MonitorTargetEntry, SiteDetail } from "@hub/contract";
import { useResource } from "@/lib/useResource";
import { Card, EmptyState } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { TargetPanel } from "@/components/monitor/TargetPanel";

/** Onglet Surveillance de la fiche : une carte par cible (version de travail, domaine final). */
export function SiteMonitorTab({ site }: { site: SiteDetail }) {
  const targets = useResource<MonitorTargetEntry[]>(`/api/sites/${site.id}/monitor`);

  if (targets.loading) {
    return (
      <p role="status" className="py-10 text-center text-sm text-[var(--muted)]">
        Lecture de la surveillance…
      </p>
    );
  }
  if (targets.error && !targets.data) {
    return (
      <Card>
        <EmptyState
          title="La surveillance n'a pas pu être lue."
          hint={targets.error}
          action={<Button variant="secondary" onClick={() => void targets.reload()}>Réessayer</Button>}
        />
      </Card>
    );
  }
  const list = targets.data ?? [];
  return (
    <div className="space-y-5">
      <h2 className="sr-only">Surveillance</h2>
      {list.length === 0 ? (
        <Card>
          <EmptyState title="Aucune adresse surveillée pour ce site." hint="La version de travail est ajoutée dès que le site est en ligne." />
        </Card>
      ) : (
        list.map((t) => (
          <TargetPanel
            key={t.id}
            target={t}
            headingLevel={3}
            onChange={(next) => targets.setData((prev) => (prev ?? []).map((x) => (x.id === next.id ? next : x)))}
          />
        ))
      )}
      {!site.finalDomain ? (
        <p className="text-sm text-[var(--muted)]">
          Le domaine final sera surveillé une fois renseigné dans l'onglet{" "}
          <Link to="?tab=serveur" className="link link-inline">
            Serveur
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}
