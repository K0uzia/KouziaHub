import { useId } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronRight, faKey, faMagnifyingGlass } from "@fortawesome/free-solid-svg-icons";
import type { SoftwareDetail } from "@hub/contract";
import { foldText, formatDay } from "@/lib/format";
import { LICENCE_JOURNAL, matchesLicense, remainingText, STATUS, STATUS_FILTERS, type StatusFilter } from "@/lib/licenses";
import { Badge, Card, EmptyState } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { StatStrip } from "@/components/ui/StatStrip";
import { FilterBar, FilterSegment } from "@/components/ui/ListFilters";
import { inputClass } from "@/components/ui/Field";

/** Onglet Licences de la fiche d'un logiciel : indicateurs, filtres (dans l'URL), liste ; le détail s'ouvre en fenêtre. */
export function LicensesTab({ detail, newButton, onOpen }: { detail: SoftwareDetail; newButton: React.ReactNode; onOpen: (id: string) => void }) {
  const [params, setParams] = useSearchParams();
  const searchId = useId();
  const status = (STATUS_FILTERS as readonly string[]).includes(params.get("etat") ?? "") ? (params.get("etat") as StatusFilter) : "all";
  const query = params.get("q") ?? "";

  function setParam(key: string, value: string, fallback: string) {
    const next = new URLSearchParams(params);
    if (!value || value === fallback) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  }

  function clearFilters() {
    const next = new URLSearchParams(params);
    next.delete("etat");
    next.delete("q");
    setParams(next, { replace: true });
  }

  const all = detail.licenses;
  const q = foldText(query.trim());
  const searched = all.filter((l) => matchesLicense(l, q));
  const shown = searched.filter((l) => status === "all" || l.status === status);
  const counts = detail.software.counts;
  const total = counts.active + counts.expiring + counts.expired;
  const filtered = status !== "all" || q !== "";
  const countOf = (s: StatusFilter) => (s === "all" ? searched.length : searched.filter((l) => l.status === s).length);

  return (
    <div className="space-y-5">
      <Banner level="info">Le nom de l'entreprise est écrit dans la clé et imposé sur les documents. Une autre entreprise demande une nouvelle clé.</Banner>

      <StatStrip
        dense
        items={[
          { label: "Valides", value: counts.active, tone: counts.active ? "success" : "default" },
          { label: "Expirent bientôt", shortLabel: "Bientôt", value: counts.expiring, tone: counts.expiring ? "warning" : "default", hint: "30 jours ou moins" },
          { label: "Expirées", value: counts.expired, tone: counts.expired ? "danger" : "default" },
          { label: "Total", value: total },
        ]}
      />

      <FilterBar>
        <FilterSegment
          label="État"
          value={status}
          onChange={(v) => setParam("etat", v, "all")}
          wrap
          options={STATUS_FILTERS.map((s) => ({ id: s, label: s === "all" ? "Toutes" : s === "active" ? "Valides" : s === "expiring" ? "Bientôt" : "Expirées", count: countOf(s) }))}
        />
        <div className="min-w-0 flex-[1_1_16rem] space-y-1.5 sm:max-w-sm">
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
              placeholder="Entreprise, client ou note"
              onChange={(e) => setParam("q", e.target.value, "")}
              className={`${inputClass} pl-9`}
            />
          </div>
        </div>
        {filtered ? (
          <Button variant="ghost" onClick={clearFilters}>
            Effacer les filtres
          </Button>
        ) : null}
      </FilterBar>

      <p className="sr-only" role="status">
        {`${shown.length} clé${shown.length > 1 ? "s" : ""} affichée${shown.length > 1 ? "s" : ""}`}
      </p>

      <Card>
        {all.length === 0 ? (
          <EmptyState
            icon={<FontAwesomeIcon icon={faKey} className="h-5 w-5" aria-hidden />}
            title="Aucune clé pour l'instant."
            hint={detail.signing ? "La première clé émise apparaîtra ici, avec sa date d'expiration." : undefined}
            action={detail.signing ? newButton : undefined}
          />
        ) : shown.length === 0 ? (
          <EmptyState title="Aucune clé pour ces filtres." action={<Button variant="secondary" onClick={clearFilters}>Effacer les filtres</Button>} />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {shown.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => onOpen(l.id)}
                  className="flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-hover)] sm:px-5"
                >
                  <span className="grid min-w-0 flex-1 gap-x-6 gap-y-1 md:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_auto] md:items-center">
                    <span className="min-w-0">
                      <span className="block break-words text-sm font-semibold text-[var(--text)]">{l.entreprise}</span>
                      <span className="block truncate text-xs text-[var(--muted)]">
                        {l.erpClientId ? (l.clientName ?? "Client de l'ERP non lu") : "Sans client de l'ERP"}
                        {l.notes ? `, ${l.notes}` : ""}
                      </span>
                    </span>
                    <span className="text-xs text-[var(--muted)] md:text-sm">
                      Du {formatDay(l.emise)} au {formatDay(l.expire)}
                    </span>
                    <span className="flex flex-wrap items-center gap-2 md:justify-end">
                      <Badge tone={STATUS[l.status].tone}>{STATUS[l.status].label}</Badge>
                      <span className="text-xs text-[var(--muted)]">{remainingText(l.expire, detail.today)}</span>
                    </span>
                  </span>
                  <FontAwesomeIcon icon={faChevronRight} className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Link to={LICENCE_JOURNAL} className="link inline-flex min-h-11 items-center text-sm font-medium">
        Journal des clés de licence
      </Link>
    </div>
  );
}
