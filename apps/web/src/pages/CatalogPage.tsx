import { useId, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faGlobe, faMagnifyingGlass, faPlus } from "@fortawesome/free-solid-svg-icons";
import type { CatalogResponse, Notice, SiteSummary } from "@hub/contract";
import { useResource, useStoredChoice } from "@/lib/useResource";
import { useTitle } from "@/lib/useTitle";
import { isSettling, matchesState, stateBucket, type StateFilter } from "@/lib/sites";
import { Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatStrip, type StatItem } from "@/components/ui/StatStrip";
import { Segmented } from "@/components/ui/Segmented";
import { FilterSegment, FilterSelect } from "@/components/ui/ListFilters";
import { Explain } from "@/components/ui/InfoTip";
import { Banner } from "@/components/ui/Banner";
import { inputClass } from "@/components/ui/Field";
import { SiteCard } from "@/components/sites/SiteCard";
import { SiteTable } from "@/components/sites/SiteTable";
import { NewSiteDialog } from "@/components/sites/NewSiteDialog";

type KindFilter = "all" | "client" | "perso";
const KIND_IDS: readonly KindFilter[] = ["all", "client", "perso"];
const STATE_IDS: readonly StateFilter[] = ["all", "down", "error", "creating", "offline", "online"];
const VIEWS = ["cards", "list"] as const;
/** Relecture du catalogue tant qu'un site change d'état (création, mise en ligne, certificat). */
const POLL_MS = 3000;
/** Mode démonstration : seulement Cloudflare simulé (aucun jeton API). L'ERP non relié a son propre bandeau. */
const DEMO_SHORT: Partial<Record<Notice["code"], string>> = {
  cloudflare_fake: "Cloudflare simulé",
};
/** Section du README qui explique le lien avec l'ERP (dépôt privé, ouvert avec le compte GitHub d'Alexandre). */
const README_ERP = "https://github.com/K0uzia/KouziaHub#d-lien-avec-lerp-lecture-des-clients";

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
  // Tri par défaut : dernière modification d'abord (comme l'API), en cartes comme en liste.
  const shown = byQuery.filter((s) => matchesState(s, stateFilter)).sort((a, b) => b.touchedAt.localeCompare(a.touchedAt));

  const count = (f: (s: SiteSummary) => boolean, list: SiteSummary[]) => list.filter(f).length;
  // Nombre par valeur, comme les filtres de l'ERP (Tous 12, Clients 9, Perso 3).
  const kindOptions = [
    { id: "all" as const, label: "Tous", count: sites.length },
    { id: "client" as const, label: "Clients", count: count((s) => s.kind === "CLIENT", sites) },
    { id: "perso" as const, label: "Perso", count: count((s) => s.kind === "PERSO", sites) },
  ];
  const stateOptions = [
    { id: "all" as const, label: "Tous les états", count: byQuery.length },
    { id: "online" as const, label: "En ligne", count: count((s) => matchesState(s, "online"), byQuery) },
    { id: "offline" as const, label: "Hors ligne", count: count((s) => matchesState(s, "offline"), byQuery) },
    { id: "creating" as const, label: "En création", count: count((s) => matchesState(s, "creating"), byQuery) },
    { id: "error" as const, label: "Erreur", count: count((s) => matchesState(s, "error"), byQuery) },
    { id: "down" as const, label: "En panne", count: count((s) => matchesState(s, "down"), byQuery) },
  ];

  function errorParams() {
    const next = new URLSearchParams(params);
    next.set("etat", "error");
    next.delete("type");
    next.delete("q");
    return next.toString();
  }

  const notices = catalog.data?.notices ?? [];
  const demoNotices = notices.filter((n) => n.code in DEMO_SHORT);
  const otherNotices = notices.filter((n) => !(n.code in DEMO_SHORT));
  const stats = catalog.data?.stats;
  // Compteurs tirés du même état unique que les badges et les filtres (une panne compte en panne, pas en ligne).
  const tally = (f: Exclude<StateFilter, "all">) => count((s) => stateBucket(s) === f, sites);
  const errors = tally("error");
  const statItems: StatItem[] = stats
    ? [
        { label: "En ligne", value: tally("online"), tone: tally("online") ? "success" : "default" },
        { label: "En panne", shortLabel: "Pannes", value: tally("down"), tone: tally("down") ? "danger" : "default" },
        { label: "Hors ligne", value: tally("offline") },
        { label: "En création", shortLabel: "Création", value: tally("creating"), tone: tally("creating") ? "warning" : "default" },
        { label: "En erreur", shortLabel: "Erreurs", value: errors, tone: errors ? "danger" : "default" },
        {
          label: "Projets Cloudflare",
          shortLabel: "Projets",
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
        subtitle={<span className="max-sm:sr-only">Versions de travail des sites, sur leur adresse en .kouzia.com.</span>}
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
        <div className="space-y-4 sm:space-y-6">
          {statItems.length ? <StatStrip items={statItems} dense className="lg:grid-cols-6" /> : null}

          {errors ? (
            // Sites en erreur remontés en tête, avec un lien qui filtre la liste (au lieu d'un filtre à deviner).
            <Banner
              level="error"
              action={
                stateFilter === "error" ? undefined : (
                  <Link to={`?${errorParams()}`} replace className="link inline-flex min-h-11 items-center text-sm font-medium">
                    Afficher {errors > 1 ? "ces sites" : "ce site"}
                  </Link>
                )
              }
            >
              {errors > 1 ? `${errors} sites en erreur` : "1 site en erreur"} : une opération a échoué, elle peut être reprise depuis la fiche.
            </Banner>
          ) : null}
          {demoNotices.length ? (
            // Mode démonstration (Cloudflare simulé) : bandeau court au téléphone.
            <Banner level="info" className="max-sm:py-2">
              <span className="font-medium">Mode démonstration</span>
              <span className="sm:hidden"> : {demoNotices.map((n) => DEMO_SHORT[n.code]).join(", ")}.</span>
              <span className="hidden sm:inline"> : {demoNotices.map((n) => n.message).join(" ")}</span>
            </Banner>
          ) : null}
          {otherNotices.length ? (
            <div className="space-y-2">
              {otherNotices.map((n) => (
                <Banner
                  key={n.code}
                  level={n.level}
                  action={
                    n.code === "orphans" ? (
                      <Link to="/reglages#controles" className="link inline-flex min-h-11 items-center text-sm font-medium">
                        Voir les contrôles
                      </Link>
                    ) : n.code === "erp_fake" ? (
                      <a href={README_ERP} target="_blank" rel="noopener noreferrer" className="link inline-flex min-h-11 items-center text-sm font-medium">
                        Voir la marche à suivre<span className="sr-only"> (README, nouvel onglet)</span>
                      </a>
                    ) : undefined
                  }
                >
                  {n.message}
                  {n.code === "fail_open" ? (
                    <>
                      {" "}
                      <Explain k="failClosed" />
                    </>
                  ) : null}
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
              <section aria-labelledby={`${searchId}-all`} className="min-w-0 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 id={`${searchId}-all`} className="text-lg font-semibold">
                    Tous les sites
                  </h2>
                  <Segmented options={[{ id: "cards", label: "Cartes" }, { id: "list", label: "Liste" }]} value={view} onChange={setView} label="Affichage" />
                </div>
                {/* Deux axes séparés : Type (contrôle segmenté, 3 choix) et État (liste native avec le nombre de
                    sites par état) ; recherche à part. Tout est dans l'URL (?type=, ?etat=, ?q=). */}
                <div className="catalog-tools">
                  <div className="min-w-0 space-y-1.5 [grid-area:search]">
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
                        placeholder="Site ou client"
                        onChange={(e) => setParam("q", e.target.value, "")}
                        className={`${inputClass} pl-9`}
                      />
                    </div>
                  </div>
                  <FilterSegment
                    label="Type de site"
                    options={kindOptions}
                    value={kind}
                    onChange={(v) => setParam("type", v, "all")}
                    compact
                    className="[grid-area:type]"
                  />
                  <FilterSelect label="État" options={stateOptions} value={stateFilter} onChange={(v) => setParam("etat", v, "all")} className="[grid-area:state] sm:w-full" />
                </div>

                <p role="status" className="text-sm text-[var(--muted)] max-sm:sr-only">
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
