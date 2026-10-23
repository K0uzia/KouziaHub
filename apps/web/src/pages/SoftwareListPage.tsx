import { Link } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronRight, faKey } from "@fortawesome/free-solid-svg-icons";
import type { SoftwareCatalog } from "@hub/contract";
import { plural } from "@/lib/format";
import { useResource } from "@/lib/useResource";
import { useTitle } from "@/lib/useTitle";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

/** Logiciels vendus sous licence : un par carte, avec le nombre de clés par état. */
export function SoftwareListPage() {
  useTitle("Logiciels");
  const catalog = useResource<SoftwareCatalog>("/api/logiciels");
  const list = catalog.data?.software ?? [];

  return (
    <>
      <PageHeader title="Logiciels" subtitle="Clés de licence signées par le hub, vérifiées hors ligne par chaque logiciel." />
      {catalog.loading ? (
        <p role="status" className="py-16 text-center text-sm text-[var(--muted)]">
          Lecture des logiciels…
        </p>
      ) : catalog.error && !catalog.data ? (
        <Card>
          <EmptyState
            title="Les logiciels n'ont pas pu être lus."
            hint={catalog.error}
            action={<Button variant="secondary" onClick={() => void catalog.reload()}>Réessayer</Button>}
          />
        </Card>
      ) : (
        <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,20rem),1fr))]">
          {list.map((s) => {
            const total = s.counts.active + s.counts.expiring + s.counts.expired;
            return (
              <li key={s.slug}>
                <Link
                  to={`/logiciels/${s.slug}`}
                  className="ui-card flex h-full min-h-11 items-start gap-4 p-4 transition-colors hover:bg-[var(--surface-raised)] sm:p-5"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--primary-soft)] text-[var(--primary)]">
                    <FontAwesomeIcon icon={faKey} className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-base font-semibold text-[var(--text)]">{s.name}</span>
                    <span className="block text-sm text-[var(--muted)]">
                      {total === 0 ? "Aucune clé émise" : plural(total, "clé émise", "clés émises")}, format {s.format}
                    </span>
                    {total > 0 ? (
                      <span className="mt-3 flex flex-wrap gap-1.5">
                        <Badge tone="green">{plural(s.counts.active, "valide", "valides")}</Badge>
                        {s.counts.expiring ? <Badge tone="amber">{`${s.counts.expiring} expire${s.counts.expiring > 1 ? "nt" : ""} bientôt`}</Badge> : null}
                        {s.counts.expired ? <Badge tone="red">{plural(s.counts.expired, "expirée", "expirées")}</Badge> : null}
                      </span>
                    ) : null}
                  </span>
                  <FontAwesomeIcon icon={faChevronRight} className="mt-1 h-3.5 w-3.5 shrink-0 text-[var(--muted)]" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
