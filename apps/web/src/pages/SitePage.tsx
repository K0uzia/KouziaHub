import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowUpRightFromSquare } from "@fortawesome/free-solid-svg-icons";
import type { OperationKind, SiteDetail, VersionEntry } from "@hub/contract";
import { useResource } from "@/lib/useResource";
import { useTitle } from "@/lib/useTitle";
import { isSettling, OPERATION_TITLE, waitsForCertificate } from "@/lib/sites";
import { Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Button, ButtonLink, buttonClass } from "@/components/ui/Button";
import { Tabs, useTabParam } from "@/components/ui/Tabs";
import { Banner } from "@/components/ui/Banner";
import { StateBadge } from "@/components/sites/StateBadge";
import { OperationProgress } from "@/components/sites/OperationProgress";
import { SummaryPanel } from "@/components/sites/SummaryPanel";
import { FilesTab } from "@/components/sites/FileExplorer";
import { VersionsTab } from "@/components/sites/VersionsTab";
import { ThumbnailTab } from "@/components/sites/ThumbnailTab";
import { SiteSettingsTab } from "@/components/sites/SiteSettingsTab";
import { ServerTab } from "@/components/sites/ServerTab";
import { SiteMonitorTab } from "@/components/monitor/SiteMonitorTab";

const TAB_IDS = ["fichiers", "versions", "surveillance", "vignette", "serveur", "reglages"] as const;
type TabId = (typeof TAB_IDS)[number];
/** Relecture de la fiche pendant une opération ou un certificat en attente (2 à 3 s), arrêtée sinon. */
const POLL_MS = 2500;

export function SitePage() {
  const { id = "" } = useParams();
  const [settling, setSettling] = useState(false);
  const site = useResource<SiteDetail>(`/api/sites/${id}`, settling ? POLL_MS : null);
  const versions = useResource<VersionEntry[]>(`/api/sites/${id}/versions`);
  const [tab, setTab] = useTabParam<TabId>(TAB_IDS, "fichiers");
  const [refreshKey, setRefreshKey] = useState(0);
  const data = site.data;
  useTitle(data?.name ?? "Site");

  const nowSettling = data ? isSettling(data) : false;
  if (nowSettling !== settling) setSettling(nowSettling);

  // Fin d'une opération observée par la relecture : message, puis relecture des fichiers et des versions.
  const lastOp = useRef<{ id: string; kind: OperationKind; status: string } | null>(null);
  const reloadVersions = versions.reload;
  useEffect(() => {
    if (!data) return;
    const prev = lastOp.current;
    const op = data.operation;
    // « CERT » : opération terminée sauf le certificat (étape en attente).
    const status = op ? (waitsForCertificate(data) ? "CERT" : op.status) : null;
    if (prev && (prev.status === "RUNNING" || prev.status === "CERT") && status !== prev.status) {
      const same = op?.id === prev.id;
      if (same && status === "FAILED") toast.error(`${OPERATION_TITLE[prev.kind]} : échec, voir le détail.`);
      else if (same && status === "CERT") toast.info(`${OPERATION_TITLE[prev.kind]} : certificat en cours, quelques minutes.`);
      else if (prev.status === "CERT") toast.success(`Certificat actif : ${data.hostname} répond.`);
      else toast.success(`${OPERATION_TITLE[prev.kind]} : terminé`);
      setRefreshKey((k) => k + 1);
      void reloadVersions();
    }
    lastOp.current = op && status ? { id: op.id, kind: op.kind, status } : null;
  }, [data, reloadVersions]);

  const onSite = site.setData;
  const reloadSite = site.reload;

  if (site.loading) {
    return (
      <p role="status" className="py-16 text-center text-sm text-[var(--muted)]">
        Chargement du site…
      </p>
    );
  }

  if (!data) {
    return (
      <>
        <PageHeader title="Site introuvable" back={{ to: "/", label: "Sites" }} />
        <Card>
          <EmptyState
            title={site.error ?? "Ce site n'existe pas ou a été supprimé."}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="secondary" onClick={() => void site.reload()}>
                  Réessayer
                </Button>
                <ButtonLink to="/">Retour aux sites</ButtonLink>
              </div>
            }
          />
        </Card>
      </>
    );
  }

  const nextVersion = Math.max(0, ...(versions.data ?? []).map((v) => v.number), data.currentVersion?.number ?? 0) + 1;
  const showOperation =
    data.operation && (data.operation.status === "RUNNING" || data.operation.status === "FAILED" || waitsForCertificate(data));

  return (
    <>
      <PageHeader
        back={{ to: "/", label: "Sites" }}
        title={data.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StateBadge site={data} />
            <span className="break-all font-mono">{data.hostname}</span>
          </span>
        }
        actions={
          data.state === "ONLINE" ? (
            <a href={data.url} target="_blank" rel="noopener noreferrer" className={buttonClass("secondary")}>
              <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3.5 w-3.5" aria-hidden />
              Ouvrir le site
              <span className="sr-only">(nouvel onglet)</span>
            </a>
          ) : null
        }
      />

      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="min-w-0 space-y-5">
          {site.error ? (
            <Banner level="warning" action={<Button variant="ghost" onClick={() => void site.reload()}>Réessayer</Button>}>
              Dernière actualisation impossible : {site.error}
            </Banner>
          ) : null}
          {showOperation ? <OperationProgress siteId={data.id} operation={data.operation!} onSite={onSite} /> : null}
          {!showOperation && data.state === "ONLINE" && data.domainStatus === "PENDING" ? (
            <Banner level="info">Certificat en cours : {data.hostname} répondra d'ici quelques minutes.</Banner>
          ) : null}
          {data.state === "DELETING" ? <Banner level="warning">Suppression en cours : la fiche disparaîtra à la fin.</Banner> : null}

          <Tabs
            label="Sections du site"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "fichiers", label: "Fichiers", count: data.fileCount },
              { id: "versions", label: "Versions", count: versions.data?.length ?? null },
              { id: "surveillance", label: "Surveillance" },
              { id: "vignette", label: "Vignette" },
              { id: "serveur", label: "Serveur" },
              { id: "reglages", label: "Réglages" },
            ]}
          >
            {tab === "fichiers" ? (
              <FilesTab
                site={data}
                nextVersion={nextVersion}
                refreshKey={refreshKey}
                onSite={onSite}
                onFilesChanged={() => void reloadSite()}
              />
            ) : tab === "versions" ? (
              <VersionsTab
                site={data}
                versions={versions}
                onSite={onSite}
                onRestored={() => {
                  setRefreshKey((k) => k + 1);
                  void reloadSite();
                  setTab("fichiers");
                }}
                onGoServer={() => setTab("serveur")}
              />
            ) : tab === "surveillance" ? (
              <SiteMonitorTab site={data} />
            ) : tab === "serveur" ? (
              <ServerTab site={data} onSite={onSite} />
            ) : tab === "vignette" ? (
              <ThumbnailTab site={data} onSite={onSite} reloadSite={reloadSite} />
            ) : (
              <SiteSettingsTab
                site={data}
                onSite={onSite}
                onPurged={() => {
                  setRefreshKey((k) => k + 1);
                  void reloadSite();
                  void reloadVersions();
                }}
              />
            )}
          </Tabs>
        </div>

        <aside aria-label="Synthèse du site" className="min-w-0 lg:sticky lg:top-0">
          <SummaryPanel site={data} onSite={onSite} />
        </aside>
      </div>
    </>
  );
}
