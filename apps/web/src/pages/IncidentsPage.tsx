import { useRef } from "react";
import { Link } from "react-router-dom";
import type { MonitorIncidentEntry, Page } from "@hub/contract";
import { formatDateTime } from "@/lib/format";
import { basisLabel, formatDuration, formatSince } from "@/lib/monitor";
import { useResource } from "@/lib/useResource";
import { useTitle } from "@/lib/useTitle";
import { apiQuery, useUrlList } from "@/lib/urlList";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { Field, Input } from "@/components/ui/Field";
import { FilterBar, FilterSegment } from "@/components/ui/ListFilters";
import { Pagination } from "@/components/ui/Pagination";

const PAGE_SIZE = 20;
const STATES = [
  { id: "tous", label: "Tous" },
  { id: "open", label: "En cours" },
  { id: "closed", label: "Terminés" },
] as const;

/**
 * Tous les incidents de la surveillance, paginés sur le serveur. Filtres dans l'URL : état, période ;
 * « adresse » ou « site » restreignent la liste (liens depuis une adresse ou la fiche d'un site).
 */
export function IncidentsPage() {
  useTitle("Incidents");
  const list = useUrlList({ adresse: "", site: "", etat: "tous", du: "", au: "" });
  const { adresse, site, etat, du, au } = list.values;
  const query = apiQuery({ page: list.page, pageSize: PAGE_SIZE, targetId: adresse, siteId: site, state: etat === "tous" ? undefined : etat, from: du, to: au });
  const incidents = useResource<Page<MonitorIncidentEntry>>(`/api/monitor/incidents?${query}`, null, { keepData: true });
  const topRef = useRef<HTMLHeadingElement>(null);
  const data = incidents.data;
  const filters = ["etat", "du", "au"] as const;
  const filtered = list.isFiltered([...filters]);
  const scope = adresse || site ? (data?.items[0]?.targetLabel ?? null) : null;

  return (
    <>
      <PageHeader
        back={adresse ? { to: `/surveillance/${adresse}`, label: "Adresse surveillée" } : site ? { to: `/sites/${site}?tab=surveillance`, label: "Fiche du site" } : { to: "/surveillance", label: "Surveillance" }}
        title="Incidents"
        subtitle={
          adresse || site ? (
            <span>
              {scope ? <>De {site ? "ce site" : <strong className="text-[var(--text)]">{scope}</strong>}. </> : null}
              <Link to="/surveillance/incidents" className="link link-inline">
                Toutes les adresses
              </Link>
            </span>
          ) : (
            "Pannes vues par la surveillance, de la plus récente à la plus ancienne."
          )
        }
      />
      <div className="space-y-4">
        <FilterBar>
          <FilterSegment label="État" value={etat as (typeof STATES)[number]["id"]} onChange={(v) => list.setFilter("etat", v)} options={STATES} />
          <Field label="Du" className="max-sm:flex-[1_1_8rem] sm:w-44">
            <Input type="date" value={du} max={au || undefined} onChange={(e) => list.setFilter("du", e.target.value)} />
          </Field>
          <Field label="Au" className="max-sm:flex-[1_1_8rem] sm:w-44">
            <Input type="date" value={au} min={du || undefined} onChange={(e) => list.setFilter("au", e.target.value)} />
          </Field>
          {filtered ? (
            <Button variant="ghost" onClick={() => list.clear([...filters])}>
              Effacer les filtres
            </Button>
          ) : null}
        </FilterBar>

        <h2 ref={topRef} tabIndex={-1} className="text-sm text-[var(--muted)] focus-visible:outline-offset-4">
          {data ? `${data.total} incident${data.total > 1 ? "s" : ""}${filtered ? " pour ces filtres" : ""}` : "Lecture des incidents…"}
        </h2>

        {incidents.error && !data ? (
          <Banner level="error" action={<Button variant="ghost" onClick={() => void incidents.reload()}>Réessayer</Button>}>
            {incidents.error}
          </Banner>
        ) : !data ? null : data.items.length === 0 ? (
          <Card>
            {data.total > 0 ? (
              <EmptyState title="Cette page n'existe pas." action={<Button variant="secondary" onClick={() => list.setPage(1)}>Revenir à la première page</Button>} />
            ) : filtered ? (
              <EmptyState title="Aucun incident pour ces filtres." action={<Button variant="secondary" onClick={() => list.clear([...filters])}>Effacer les filtres</Button>} />
            ) : (
              <EmptyState title="Aucun incident enregistré." />
            )}
          </Card>
        ) : (
          <>
            {incidents.error ? <Banner level="warning">Dernière lecture impossible : {incidents.error}</Banner> : null}
            <IncidentList items={data.items} withTarget={!adresse} />
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={list.setPage} label="Pages des incidents" focusRef={topRef} />
          </>
        )}
      </div>
    </>
  );
}

/** Liste d'incidents : adresse (lien), début, durée ou « en cours », cause et point de vue. */
export function IncidentList({ items, withTarget = true }: { items: MonitorIncidentEntry[]; withTarget?: boolean }) {
  return (
    <ul className="ui-card divide-y divide-[var(--border)] overflow-hidden p-0">
      {items.map((i) => (
        <li key={i.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
          <div className="min-w-0">
            {withTarget ? (
              <Link to={`/surveillance/${i.targetId}`} className="link inline-flex min-h-6 items-center font-medium break-words">
                {i.targetLabel}
              </Link>
            ) : null}
            <span className="block text-[var(--text)]">
              {formatDateTime(i.startedAt)}
              {i.endedAt ? `, durée ${formatDuration(i.durationMs ?? 0)}` : ""}
            </span>
            <span className="block text-xs text-[var(--muted)]">
              {i.cause ?? "Cause non précisée"} ; {basisLabel(i.basis)}
            </span>
          </div>
          {i.endedAt ? <Badge tone="neutral">Terminé</Badge> : <Badge tone="red">En cours depuis {formatSince(i.startedAt)}</Badge>}
        </li>
      ))}
    </ul>
  );
}
