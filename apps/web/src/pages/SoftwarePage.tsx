import { useId, useState } from "react";
import { useParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowUpRightFromSquare, faPlus } from "@fortawesome/free-solid-svg-icons";
import type { LicenseDetail, LicenseSummary, SoftwareDetail } from "@hub/contract";
import { keygenCommand } from "@/lib/software";
import { useResource } from "@/lib/useResource";
import { useTitle } from "@/lib/useTitle";
import { Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Button, buttonClass } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { Tabs, useTabParam } from "@/components/ui/Tabs";
import { NewLicenseDialog, type LicensePrefill } from "@/components/licenses/NewLicenseDialog";
import { LicenseDialog } from "@/components/licenses/LicenseDialog";
import { LicensesTab } from "@/components/licenses/LicensesTab";
import { SoftwareBadges } from "@/components/licenses/SoftwareCard";
import { SoftwareSummaryPanel } from "@/components/licenses/SoftwareSummaryPanel";
import { SoftwareThumbnailTab } from "@/components/licenses/SoftwareThumbnailTab";
import { SoftwareSettingsTab } from "@/components/licenses/SoftwareSettingsTab";

const TAB_IDS = ["licences", "vignette", "reglages"] as const;

function summaryOf(l: LicenseDetail): LicenseSummary {
  const { cle: _cle, contact: _contact, ...summary } = l;
  return summary;
}

/** Même tri que le serveur : expiration la plus proche d'abord, puis entreprise. */
const byExpiry = (a: LicenseSummary, b: LicenseSummary) => a.expire.localeCompare(b.expire) || a.entreprise.localeCompare(b.entreprise, "fr");

/** Fiche d'un logiciel, sur le modèle de la fiche d'un site : onglets (licences, vignette, réglages) et synthèse. */
export function SoftwarePage() {
  const { slug = "" } = useParams();
  const detail = useResource<SoftwareDetail>(`/api/logiciels/${encodeURIComponent(slug)}`);
  const d = detail.data;
  useTitle(d ? `${d.software.name}, licences` : "Logiciels");
  const [tab, setTab] = useTabParam(TAB_IDS, "licences");
  const signingId = useId();
  const [openId, setOpenId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [prefill, setPrefill] = useState<LicensePrefill | null>(null);

  function upsert(l: LicenseDetail) {
    const s = summaryOf(l);
    detail.setData((prev) => (prev ? { ...prev, licenses: [...prev.licenses.filter((x) => x.id !== s.id), s].sort(byExpiry) } : prev));
    // Compteurs : relus sur le serveur, sans vider l'affichage.
    void detail.reload();
  }

  function openNew(next: LicensePrefill | null) {
    setPrefill(next);
    setOpenId(null);
    setNewOpen(true);
  }

  if (detail.loading) {
    return (
      <p role="status" className="py-16 text-center text-sm text-[var(--muted)]">
        Lecture du logiciel…
      </p>
    );
  }
  if (!d) {
    return (
      <>
        <PageHeader back={{ to: "/logiciels", label: "Logiciels" }} title="Logiciel" />
        <Card>
          <EmptyState
            title="Ce logiciel n'a pas pu être lu."
            hint={detail.error ?? undefined}
            action={<Button variant="secondary" onClick={() => void detail.reload()}>Réessayer</Button>}
          />
        </Card>
      </>
    );
  }

  const s = d.software;
  const total = s.counts.active + s.counts.expiring + s.counts.expired;
  const newButton = (
    <Button onClick={() => openNew(null)} disabled={!d.signing} aria-describedby={d.signing ? undefined : signingId}>
      <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
      Nouvelle clé
    </Button>
  );

  return (
    <>
      <PageHeader
        back={{ to: "/logiciels", label: "Logiciels" }}
        title={s.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <SoftwareBadges software={s} />
            <span className="break-all font-mono">clés {s.keyPrefix}</span>
          </span>
        }
        actions={
          <>
            {s.demoUrl ? (
              <a href={s.demoUrl} target="_blank" rel="noopener noreferrer" className={buttonClass("secondary")}>
                <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3.5 w-3.5" aria-hidden />
                Ouvrir la démo
                <span className="sr-only">(nouvel onglet)</span>
              </a>
            ) : null}
            {newButton}
          </>
        }
      />

      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="min-w-0 space-y-5">
          {d.signing ? null : (
            <Banner level="warning" id={signingId}>
              La clé de signature de {s.name} n'est pas en place sur le serveur. Les clés déjà émises restent consultables. Sur le serveur :{" "}
              <code className="break-words font-mono">{keygenCommand(s.slug)}</code>.
            </Banner>
          )}
          {detail.error ? (
            <Banner level="warning" action={<Button variant="ghost" onClick={() => void detail.reload()}>Réessayer</Button>}>
              Dernière actualisation impossible : {detail.error}
            </Banner>
          ) : null}

          <Tabs
            label="Sections du logiciel"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "licences", label: "Licences", count: total },
              { id: "vignette", label: "Vignette" },
              { id: "reglages", label: "Réglages" },
            ]}
          >
            {tab === "licences" ? (
              <LicensesTab detail={d} newButton={newButton} onOpen={setOpenId} />
            ) : tab === "vignette" ? (
              <SoftwareThumbnailTab detail={d} onDetail={detail.setData} />
            ) : (
              <SoftwareSettingsTab key={s.slug} detail={d} onDetail={detail.setData} />
            )}
          </Tabs>
        </div>

        <aside aria-label="Synthèse du logiciel" className="min-w-0 lg:sticky lg:top-0">
          <SoftwareSummaryPanel detail={d} />
        </aside>
      </div>

      <LicenseDialog
        licenseId={openId}
        softwareSlug={s.slug}
        all={d.licenses}
        today={d.today}
        canEmit={d.signing}
        onClose={() => setOpenId(null)}
        onOpen={setOpenId}
        onUpdated={upsert}
        onRenew={(l) =>
          openNew({ entreprise: l.entreprise, client: l.erpClientId ? { id: l.erpClientId, name: l.clientName } : null, contact: l.contact, renewOf: l.expire })
        }
      />
      <NewLicenseDialog open={newOpen} onClose={() => setNewOpen(false)} softwareSlug={s.slug} softwareName={s.name} today={d.today} prefill={prefill} onCreated={upsert} />
    </>
  );
}
