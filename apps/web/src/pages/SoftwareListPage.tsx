import { useId, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCube, faMagnifyingGlass, faPlus } from "@fortawesome/free-solid-svg-icons";
import type { SoftwareCatalog, SoftwareSummary } from "@hub/contract";
import { foldText } from "@/lib/format";
import { matchesSoftware, matchesSoftwareFilter, SOFTWARE_FILTERS, stateOf, validCount, type SoftwareFilter } from "@/lib/software";
import { LICENCE_JOURNAL } from "@/lib/licenses";
import { useResource, useStoredChoice } from "@/lib/useResource";
import { useTitle } from "@/lib/useTitle";
import { Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { StatStrip, type StatItem } from "@/components/ui/StatStrip";
import { Segmented } from "@/components/ui/Segmented";
import { FilterSelect } from "@/components/ui/ListFilters";
import { inputClass } from "@/components/ui/Field";
import { SoftwareCard } from "@/components/licenses/SoftwareCard";
import { SoftwareTable } from "@/components/licenses/SoftwareTable";
import { NewSoftwareDialog } from "@/components/licenses/NewSoftwareDialog";

const VIEWS = ["cards", "list"] as const;
const FILTER_LABEL: Record<SoftwareFilter, string> = {
  all: "Tous les états",
  ready: "Signature prête",
  nokey: "Clé de signature absente",
  renew: "Licences à renouveler",
};

/** Catalogue des logiciels vendus sous licence, sur le modèle du catalogue des sites : cartes, filtres, fiche. */
export function SoftwareListPage() {
  useTitle("Logiciels");
  const [params, setParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(params.get("nouveau") === "1");
  const [view, setView] = useStoredChoice("hub:software-view", VIEWS, "cards");
  const searchId = useId();
  const catalog = useResource<SoftwareCatalog>("/api/logiciels");
  const list = catalog.data?.software ?? [];

  const filter = (SOFTWARE_FILTERS as readonly string[]).includes(params.get("etat") ?? "") ? (params.get("etat") as SoftwareFilter) : "all";
  const query = params.get("q") ?? "";

  function setParam(key: string, value: string, fallback: string) {
    const next = new URLSearchParams(params);
    if (!value || value === fallback) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  }

  const q = foldText(query.trim());
  const searched = list.filter((s) => matchesSoftware(s, q));
  const shown = searched.filter((s) => matchesSoftwareFilter(s, filter));
  const count = (f: SoftwareFilter) => searched.filter((s) => matchesSoftwareFilter(s, f)).length;
  const sum = (f: (s: SoftwareSummary) => number) => list.reduce((n, s) => n + f(s), 0);
  const expiring = sum((s) => s.counts.expiring);
  const expired = sum((s) => s.counts.expired);
  const noKey = list.filter((s) => stateOf(s) === "nokey").length;
  const statItems: StatItem[] = [
    { label: "Logiciels", value: list.length },
    { label: "Licences en cours", shortLabel: "En cours", value: sum(validCount), tone: sum(validCount) ? "success" : "default" },
    { label: "Expirent bientôt", shortLabel: "Bientôt", value: expiring, tone: expiring ? "warning" : "default", hint: "30 jours ou moins" },
    { label: "Expirées", value: expired, tone: expired ? "danger" : "default" },
  ];

  const createButton = (
    <Button onClick={() => setCreateOpen(true)}>
      <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
      Nouveau logiciel
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Logiciels"
        subtitle={<span className="max-sm:sr-only">Clés de licence signées par le hub, vérifiées hors ligne par chaque logiciel.</span>}
        actions={createButton}
      />

      {catalog.error && !catalog.data ? (
        <Card>
          <EmptyState
            title="Les logiciels n'ont pas pu être lus."
            hint={catalog.error}
            action={<Button variant="secondary" onClick={() => void catalog.reload()}>Réessayer</Button>}
          />
        </Card>
      ) : catalog.loading ? (
        <p role="status" className="py-16 text-center text-sm text-[var(--muted)]">
          Lecture des logiciels…
        </p>
      ) : (
        <div className="space-y-4 sm:space-y-6">
          <StatStrip items={statItems} dense />

          {noKey ? (
            <Banner
              level="warning"
              action={
                filter === "nokey" ? undefined : (
                  <Link to="?etat=nokey" replace className="link inline-flex min-h-11 items-center text-sm font-medium">
                    Afficher {noKey > 1 ? "ces logiciels" : "ce logiciel"}
                  </Link>
                )
              }
            >
              {noKey > 1 ? `${noKey} logiciels sans clé de signature : leurs licences` : "1 logiciel sans clé de signature : ses licences"} ne peuvent pas encore être émises.
            </Banner>
          ) : null}
          {catalog.error ? (
            <Banner level="warning" action={<Button variant="ghost" onClick={() => void catalog.reload()}>Réessayer</Button>}>
              Dernière actualisation impossible : {catalog.error}
            </Banner>
          ) : null}

          {list.length === 0 ? (
            <Card>
              <EmptyState
                icon={<FontAwesomeIcon icon={faCube} className="h-5 w-5" aria-hidden />}
                title="Aucun logiciel pour l'instant"
                hint="Ajoutez un logiciel, puis créez sa clé de signature sur le serveur pour émettre ses licences."
                action={createButton}
              />
            </Card>
          ) : (
            <section aria-labelledby={`${searchId}-all`} className="min-w-0 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id={`${searchId}-all`} className="text-lg font-semibold">
                  Tous les logiciels
                </h2>
                <Segmented options={[{ id: "cards", label: "Cartes" }, { id: "list", label: "Liste" }]} value={view} onChange={setView} label="Affichage" />
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-0 flex-[1_1_16rem] space-y-1.5 sm:max-w-[26rem]">
                  <label htmlFor={searchId} className="block text-sm font-medium text-[var(--text)]">
                    Rechercher
                  </label>
                  <div className="relative">
                    <FontAwesomeIcon icon={faMagnifyingGlass} className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted)]" aria-hidden />
                    <input
                      id={searchId}
                      type="search"
                      value={query}
                      autoComplete="off"
                      placeholder="Nom, identifiant ou préfixe"
                      onChange={(e) => setParam("q", e.target.value, "")}
                      className={`${inputClass} pl-9`}
                    />
                  </div>
                </div>
                <FilterSelect
                  label="État"
                  options={SOFTWARE_FILTERS.map((f) => ({ id: f, label: FILTER_LABEL[f], count: count(f) }))}
                  value={filter}
                  onChange={(v) => setParam("etat", v, "all")}
                  className="min-w-0 flex-[1_1_12rem] sm:max-w-[16rem]"
                />
              </div>

              <p role="status" className="text-sm text-[var(--muted)] max-sm:sr-only">
                {shown.length === list.length
                  ? `${list.length} logiciel${list.length > 1 ? "s" : ""}`
                  : `${shown.length} logiciel${shown.length > 1 ? "s" : ""} sur ${list.length}`}
              </p>

              {shown.length === 0 ? (
                <Card>
                  <EmptyState
                    title="Aucun logiciel ne correspond."
                    hint="Changez la recherche ou le filtre."
                    action={<Button variant="secondary" onClick={() => setParams(new URLSearchParams(), { replace: true })}>Effacer les filtres</Button>}
                  />
                </Card>
              ) : view === "cards" ? (
                <ul className="catalog-grid">
                  {shown.map((s) => (
                    <li key={s.slug} className="flex min-w-0">
                      <SoftwareCard software={s} />
                    </li>
                  ))}
                </ul>
              ) : (
                <SoftwareTable software={shown} />
              )}
            </section>
          )}

          <Link to={LICENCE_JOURNAL} className="link inline-flex min-h-11 items-center text-sm font-medium">
            Journal des clés de licence
          </Link>
        </div>
      )}

      <NewSoftwareDialog
        open={createOpen}
        taken={{ slugs: list.map((s) => s.slug), prefixes: list.map((s) => s.keyPrefix) }}
        onClose={() => {
          setCreateOpen(false);
          if (params.has("nouveau")) setParam("nouveau", "", "");
        }}
      />
    </>
  );
}
