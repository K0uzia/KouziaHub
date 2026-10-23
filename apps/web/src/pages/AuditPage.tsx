import { useRef } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircleCheck, faCircleXmark } from "@fortawesome/free-solid-svg-icons";
import type { AuditEntry, Page } from "@hub/contract";
import { formatDateTime } from "@/lib/format";
import { ACTION_FAMILY_LABEL, ACTION_LABEL, actionLabel } from "@/lib/auditLabels";
import { useResource } from "@/lib/useResource";
import { useTitle } from "@/lib/useTitle";
import { apiQuery, useUrlList } from "@/lib/urlList";
import { Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { Field, Input } from "@/components/ui/Field";
import { FilterBar, FilterSegment, FilterSelect } from "@/components/ui/ListFilters";
import { Pagination } from "@/components/ui/Pagination";

const PAGE_SIZE = 20;
const RESULTS = [
  { id: "tous", label: "Tous" },
  { id: "ok", label: "Réussis" },
  { id: "error", label: "Échecs" },
] as const;
const ACTIONS = [
  { id: "", label: "Toutes les actions" },
  ...Object.entries({ ...ACTION_LABEL, ...ACTION_FAMILY_LABEL })
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label, "fr")),
];

/** Résultat d'une action en texte et en icône. */
export function AuditResult({ result }: { result: AuditEntry["result"] }) {
  return result === "ok" ? (
    <span className="inline-flex items-center gap-1.5 text-[var(--success)]">
      <FontAwesomeIcon icon={faCircleCheck} className="h-3.5 w-3.5" aria-hidden />
      Réussi
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-[var(--danger)]">
      <FontAwesomeIcon icon={faCircleXmark} className="h-3.5 w-3.5" aria-hidden />
      Échec
    </span>
  );
}

/** Journal complet des actions : filtres dans l'URL (action, résultat, période), pages de 20 lues sur le serveur. */
export function AuditPage() {
  useTitle("Journal des actions");
  const list = useUrlList({ action: "", resultat: "tous", du: "", au: "" });
  const { action, resultat, du, au } = list.values;
  const query = apiQuery({ page: list.page, pageSize: PAGE_SIZE, action, result: resultat === "tous" ? undefined : resultat, from: du, to: au });
  const audit = useResource<Page<AuditEntry>>(`/api/audit?${query}`, null, { keepData: true });
  const topRef = useRef<HTMLHeadingElement>(null);
  const data = audit.data;
  const filtered = list.isFiltered();

  return (
    <>
      <PageHeader back={{ to: "/reglages", label: "Réglages" }} title="Journal des actions" subtitle="Toutes les actions du hub, de la plus récente à la plus ancienne." />
      <div className="space-y-4">
        <FilterBar>
          <FilterSelect label="Action" value={action} onChange={(v) => list.setFilter("action", v)} options={ACTIONS} className="max-sm:w-full sm:w-64" />
          <FilterSegment label="Résultat" value={resultat as (typeof RESULTS)[number]["id"]} onChange={(v) => list.setFilter("resultat", v)} options={RESULTS} />
          <Field label="Du" className="max-sm:flex-[1_1_8rem] sm:w-44">
            <Input type="date" value={du} max={au || undefined} onChange={(e) => list.setFilter("du", e.target.value)} />
          </Field>
          <Field label="Au" className="max-sm:flex-[1_1_8rem] sm:w-44">
            <Input type="date" value={au} min={du || undefined} onChange={(e) => list.setFilter("au", e.target.value)} />
          </Field>
          {filtered ? (
            <Button variant="ghost" onClick={() => list.clear()}>
              Effacer les filtres
            </Button>
          ) : null}
        </FilterBar>

        <h2 ref={topRef} tabIndex={-1} className="text-sm text-[var(--muted)] focus-visible:outline-offset-4">
          {data ? `${data.total} action${data.total > 1 ? "s" : ""}${filtered ? " pour ces filtres" : ""}` : "Lecture du journal…"}
        </h2>

        {audit.error && !data ? (
          <Banner level="error" action={<Button variant="ghost" onClick={() => void audit.reload()}>Réessayer</Button>}>
            {audit.error}
          </Banner>
        ) : !data ? null : data.items.length === 0 ? (
          <Card>
            {data.total > 0 ? (
              <EmptyState title="Cette page n'existe pas." action={<Button variant="secondary" onClick={() => list.setPage(1)}>Revenir à la première page</Button>} />
            ) : filtered ? (
              <EmptyState title="Aucune action pour ces filtres." action={<Button variant="secondary" onClick={() => list.clear()}>Effacer les filtres</Button>} />
            ) : (
              <EmptyState title="Aucune action enregistrée pour l'instant." />
            )}
          </Card>
        ) : (
          <>
            {audit.error ? <Banner level="warning">Dernière lecture impossible : {audit.error}</Banner> : null}
            <AuditTable items={data.items} caption={`Actions, page ${data.page}`} />
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={list.setPage} label="Pages du journal" focusRef={topRef} />
          </>
        )}
      </div>
    </>
  );
}

/** Tableau des actions (cartes empilées sous 768 px). */
export function AuditTable({ items, caption }: { items: AuditEntry[]; caption: string }) {
  return (
    <div className="ui-card ui-table-wrap max-md:border-0 max-md:bg-transparent max-md:shadow-none">
      <table className="ui-table ui-table-stack">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Action</th>
            <th scope="col">Site</th>
            <th scope="col">Résultat</th>
            <th scope="col">Détail</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.id}>
              <td data-label="Date" className="nowrap">
                {formatDateTime(e.at)}
              </td>
              <td data-label="Action" className="wrap">
                {actionLabel(e.action) ?? <span className="font-mono text-xs">{e.action}</span>}
              </td>
              <td data-label="Site" className="wrap">
                {e.siteSlug ? <span className="font-mono">{e.siteSlug}</span> : <span className="text-[var(--muted)]">Aucun</span>}
              </td>
              <td data-label="Résultat" className="nowrap">
                <AuditResult result={e.result} />
              </td>
              <td data-label="Détail" className="wrap text-[var(--muted)]">
                {e.detail ?? "Aucun"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
