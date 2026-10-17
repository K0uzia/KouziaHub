import { useId, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faGlobe, faMagnifyingGlass, faPlus } from "@fortawesome/free-solid-svg-icons";
import type { CatalogResponse, SiteSummary } from "@hub/contract";
import { useResource, useStoredChoice } from "@/lib/useResource";
import { useTitle } from "@/lib/useTitle";
import { isSettling, matchesState, type StateFilter } from "@/lib/sites";
import { Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatStrip, type StatItem } from "@/components/ui/StatStrip";
import { FilterChips } from "@/components/ui/FilterChips";
import { Segmented } from "@/components/ui/Segmented";
import { Banner } from "@/components/ui/Banner";
import { inputClass } from "@/components/ui/Field";
import { SiteCard } from "@/components/sites/SiteCard";
import { SiteTable } from "@/components/sites/SiteTable";
import { NewSiteDialog } from "@/components/sites/NewSiteDialog";

type KindFilter = "all" | "client" | "perso";
const KIND_IDS: readonly KindFilter[] = ["all", "client", "perso"];
const STATE_IDS: readonly StateFilter[] = ["all", "online", "offline", "creating", "error"];
const VIEWS = ["cards", "list"] as const;
/** Rangée « Modifiés récemment » : seulement quand le catalogue dépasse ce nombre (sinon elle répète la grille). */
const RECENT_MIN_SITES = 5;
const RECENT_COUNT = 8;
/** Relecture du catalogue tant qu'un site change d'état (création, mise en ligne, certificat). */
const POLL_MS = 3000;

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function matchesQuery(site: SiteSummary, q: string): boolean {
  if (!q) return true;
  return [site.name, site.clientName ?? "", site.slug, site.hostname, site.label ?? ""].some((v) => normalize(v).includes(q));
}

export function CatalogPage() {
  useTitle("Sites");
  const [params, setParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(params.get("nouveau") === "1");
  const [view, setView] = useStoredChoice("hub:catalog-view", VIEWS, "cards");
  const searchId = useId();

  const kind = (KIND_IDS as readonly string[]).includes(params.get("type") ?? "") ? (params.get("type") as KindFilter) : "all";
  const stateFilter = (STATE_IDS as readonly string[]).includes(params.get("etat") ?? "")
    ? (params.get("etat") as StateFilter)
    : "all";
  const query = params.get("q") ?? "";

  const [settling, setSettling] = useState(false);
  const catalog = useResource<CatalogResponse>("/api/sites", settling ? POLL_MS : null);
  const sites = useMemo(() => catalog.data?.sites ?? [], [catalog.data]);
  const nowSettling = sites.some(isSettling);
  if (nowSettling !== settling) setSettling(nowSettling);

  function setParam(key: string, value: string, fallback: string) {
    const next = new URLSearchParams(params);
    if (!value || value === fallback) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  }

  const q = normalize(query.trim());
  const byKind = sites.filter((s) => (kind === "all" ? true : kind === "client" ? s.kind === "CLIENT" : s.kind === "PERSO"));
  const byQuery = byKind.filter((s) => matchesQuery(s, q));
  const shown = byQuery.filter((s) => matchesState(s, stateFilter)).sort((a, b) => a.name.localeCompare(b.name, "fr"));
  const filtering = kind !== "all" || stateFilter !== "all" || q !== "";
  const recent =
    !filtering && sites.length >= RECENT_MIN_SITES
      ? [...sites].sort((a, b) => b.touchedAt.localeCompare(a.touchedAt)).slice(0, RECENT_COUNT)
      : [];

  const count = (f: (s: SiteSummary) => boolean, list: SiteSummary[]) => list.filter(f).length;
  const kindOptions = [
    { id: "all" as const, label: "Tous", count: sites.length },
    { id: "client" as const, label: "Clients", count: count((s) => s.kind === "CLIENT", sites) },
    { id: "perso" as const, label: "Perso", count: count((s) => s.kind === "PERSO", sites) },
  ];
  const stateOptions = [
    { id: "all" as const, label: "Tous les états" },
    { id: "online" as const, label: "En ligne", count: count((s) => matchesState(s, "online"), byQuery) },
    { id: "offline" as const, label: "Hors ligne", count: count((s) => matchesState(s, "offline"), byQuery) },
    { id: "creating" as const, label: "En création", count: count((s) => matchesState(s, "creating"), byQuery) },
    { id: "error" as const, label: "Erreur", count: count((s) => matchesState(s, "error"), byQuery) },
  ];

  const stats = catalog.data?.stats;
  const statItems: StatItem[] = stats
    ? [
        { label: "En ligne", value: stats.online, tone: stats.online ? "success" : "default" },
        { label: "Hors ligne", value: stats.offline },
        { label: "En création", value: stats.creating, tone: stats.creating ? "warning" : "default" },
        { label: "En erreur", value: stats.errors, tone: stats.errors ? "danger" : "default" },
        {
          label: "Projets Cloudflare utilisés",
          shortLabel: "Projets Cloudflare",
          value: stats.projectsUsed == null ? "Inconnu" : `${stats.projectsUsed} / ${stats.projectsLimit}`,
          hint: stats.projectsUsed == null ? `Limite : ${stats.projectsLimit}` : undefined,
          tone: stats.projectsUsed != null && stats.projectsUsed >= stats.projectsLimit * 0.9 ? "warning" : "default",
        },
      ]
    : [];

  const createButton = (
    <Button onClick={() => setCreateOpen(true)}>
      <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
      Nouveau site
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Sites"
        subtitle="Versions de travail des sites, sur leur adresse en .kouzia.com."
        actions={createButton}
      />

      {catalog.error && !catalog.data ? (
        <Card>
          <EmptyState
            title="Le catalogue n'a pas pu être lu."
            hint={catalog.error}
            action={<Button variant="secondary" onClick={() => void catalog.reload()}>Réessayer</Button>}
          />
        </Card>
      ) : catalog.loading ? (
        <p role="status" className="py-16 text-center text-sm text-[var(--muted)]">
          Chargement des sites…
        </p>
      ) : (
        <div className="space-y-6">
          {statItems.length ? <StatStrip items={statItems} /> : null}

          {catalog.data?.notices.length ? (
            <div className="space-y-2">
              {catalog.data.notices.map((n) => (
                <Banner
                  key={n.code}
                  level={n.level}
                  action={
                    n.code === "orphans" ? (
                      <Link to="/reglages#controles" className="link inline-flex min-h-11 items-center text-sm font-medium">
                        Voir les contrôles
                      </Link>
                    ) : undefined
                  }
                >
                  {n.message}
                </Banner>
              ))}
            </div>
          ) : null}

          {catalog.error ? (
            <Banner level="warning" action={<Button variant="ghost" onClick={() => void catalog.reload()}>Réessayer</Button>}>
              Dernière actualisation impossible : {catalog.error}
            </Banner>
          ) : null}

          {sites.length === 0 ? (
            <Card>
              <EmptyState
                icon={<FontAwesomeIcon icon={faGlobe} className="h-5 w-5" aria-hidden />}
                title="Aucun site pour l'instant"
                hint="Créez la version de travail d'un client, ou un site perso. L'adresse est prête en quelques minutes."
                action={createButton}
              />
            </Card>
          ) : (
            <>
              {recent.length ? (
                <section aria-labelledby={`${searchId}-recent`} className="min-w-0">
                  <h2 id={`${searchId}-recent`} className="mb-3 text-lg font-semibold">
                    Modifiés récemment
                  </h2>
                  <ul className="recent-row custom-scrollbar">
                    {recent.map((s) => (
                      <li key={s.id} className="recent-item">
                        <SiteCard site={s} />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <section aria-labelledby={`${searchId}-all`} className="min-w-0 space-y-4">
                <h2 id={`${searchId}-all`} className="text-lg font-semibold">
                  Tous les sites
                </h2>
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                    <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-md">
                      <label htmlFor={searchId} className="block text-sm font-medium text-[var(--text)]">
                        Rechercher
                      </label>
                      <div className="relative">
                        <FontAwesomeIcon
                          icon={faMagnifyingGlass}
                          className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted)]"
                          aria-hidden
                        />
                        <input
                          id={searchId}
                          type="search"
                          value={query}
                          autoComplete="off"
                          placeholder="Nom, client ou sous-domaine"
                          onChange={(e) => setParam("q", e.target.value, "")}
                          className={`${inputClass} pl-9`}
                        />
                      </div>
                    </div>
                    <Segmented options={[{ id: "cards", label: "Cartes" }, { id: "list", label: "Liste" }]} value={view} onChange={setView} label="Affichage" />
                  </div>
                  <FilterChips options={kindOptions} value={kind} onChange={(v) => setParam("type", v, "all")} label="Type de site" />
                  <FilterChips options={stateOptions} value={stateFilter} onChange={(v) => setParam("etat", v, "all")} label="État" />
                </div>

                <p role="status" className="text-sm text-[var(--muted)]">
                  {shown.length === sites.length
                    ? `${sites.length} site${sites.length > 1 ? "s" : ""}`
                    : `${shown.length} site${shown.length > 1 ? "s" : ""} sur ${sites.length}`}
                </p>

                {shown.length === 0 ? (
                  <Card>
                    <EmptyState
                      title="Aucun site ne correspond."
                      hint="Changez la recherche ou les filtres."
                      action={
                        <Button variant="secondary" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                          Effacer les filtres
                        </Button>
                      }
                    />
                  </Card>
                ) : view === "cards" ? (
                  <ul className="catalog-grid">
                    {shown.map((s) => (
                      <li key={s.id} className="flex min-w-0">
                        <SiteCard site={s} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <SiteTable sites={shown} />
                )}
              </section>
            </>
          )}
        </div>
      )}

      <NewSiteDialog
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          if (params.has("nouveau")) setParam("nouveau", "", "");
        }}
      />
    </>
  );
}
