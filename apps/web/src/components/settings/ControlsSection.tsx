import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { faCircleCheck, faCircleInfo, faMagnifyingGlass, faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import type { OrphanFinding, OrphanReport, SystemStatus } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useResource } from "@/lib/useResource";
import { Badge, Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

const FINDING_TYPE: Record<OrphanFinding["type"], string> = {
  dns: "Enregistrement DNS",
  project: "Projet Cloudflare",
  site: "Site du hub",
};

function Row({ label, icon, ink, children }: { label: string; icon: IconDefinition; ink: string; children: ReactNode }) {
  return (
    <div className="py-3">
      <dt className="flex items-start gap-3 text-sm font-medium text-[var(--text)]">
        <FontAwesomeIcon icon={icon} className={`mt-0.5 h-4 w-4 shrink-0 ${ink}`} aria-hidden />
        {label}
      </dt>
      <dd className="mt-0.5 pl-7 text-sm text-[var(--muted)]">{children}</dd>
    </div>
  );
}

const OK = { icon: faCircleCheck, ink: "text-[var(--success)]" };
const WARN = { icon: faTriangleExclamation, ink: "text-[var(--warning)]" };
const INFO = { icon: faCircleInfo, ink: "text-[var(--info)]" };

export function ControlsSection() {
  const ids = useId();
  const system = useResource<SystemStatus>("/api/system");
  const orphans = useResource<OrphanReport>("/api/orphans");
  const [checking, setChecking] = useState(false);
  const [toDelete, setToDelete] = useState<OrphanFinding | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function check() {
    setChecking(true);
    try {
      const report = await api<OrphanReport>("/api/orphans/check", { method: "POST" });
      orphans.setData(report);
      if (report.error) toast.error(report.error);
      else toast.success(report.findings.length ? `${report.findings.length} élément(s) à regarder` : "Aucun orphelin");
    } catch (err) {
      toast.error(errorMessage(err, "Vérification impossible."));
    } finally {
      setChecking(false);
    }
  }

  async function remove() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      const report = await api<OrphanReport>("/api/orphans/dns/delete", { method: "POST", json: { name: toDelete.name } });
      orphans.setData(report);
      toast.success(`Enregistrement ${toDelete.name} supprimé`);
      setToDelete(null);
    } catch (err) {
      toast.error(errorMessage(err, "Suppression impossible."));
    } finally {
      setDeleting(false);
    }
  }

  const s = system.data;
  const r = orphans.data;
  const nearLimit = s?.cloudflare.projectsUsed != null && s.cloudflare.projectsUsed >= s.cloudflare.projectsLimit * 0.9;

  return (
    <section id="controles" aria-labelledby={`${ids}-title`} className="scroll-mt-4">
      <h2 id={`${ids}-title`} className="mb-3 text-lg font-semibold">
        Contrôles
      </h2>
      <div className="space-y-4">
        <Card className="p-4 sm:p-5">
          <h3 className="text-base font-semibold">Services</h3>
          {system.loading ? (
            <p role="status" className="mt-3 text-sm text-[var(--muted)]">
              Lecture…
            </p>
          ) : system.error || !s ? (
            <Banner level="error" className="mt-3" action={<Button variant="ghost" onClick={() => void system.reload()}>Réessayer</Button>}>
              {system.error ?? "État des services indisponible."}
            </Banner>
          ) : (
            <dl className="mt-1 divide-y divide-[var(--border)]">
              <Row label="Cloudflare" {...(s.cloudflare.mode === "real" ? OK : WARN)}>
                {s.cloudflare.mode === "real"
                  ? "Compte réel : les sites sont créés pour de vrai."
                  : "Simulé : aucun site n'est réellement créé (mode d'essai)."}
              </Row>
              <Row label="Projets Cloudflare" {...(nearLimit ? WARN : s.cloudflare.projectsUsed == null ? INFO : OK)}>
                {s.cloudflare.projectsUsed == null
                  ? `Nombre inconnu pour l'instant, limite de ${s.cloudflare.projectsLimit}.`
                  : `${s.cloudflare.projectsUsed} sur ${s.cloudflare.projectsLimit} utilisés${nearLimit ? " : la limite approche." : "."}`}
              </Row>
              <Row label="ERP" {...(s.erp.mode === "fake" ? WARN : s.erp.reachable ? OK : WARN)}>
                {s.erp.mode === "fake"
                  ? "Simulé : la liste des clients est une liste d'essai."
                  : s.erp.reachable
                    ? "Joignable : les clients sont lus dans l'ERP."
                    : "Injoignable : les noms des clients ne s'affichent pas, la création d'un site client attend."}
              </Row>
              <Row label="Vignettes" {...(s.thumbnails.capture ? OK : INFO)}>
                {s.thumbnails.capture ? "Capture automatique disponible." : "Capture automatique indisponible : envoyez une image."}
              </Row>
              <Row label="Domaine des sites" {...INFO}>
                <span className="font-mono">*.{s.sitesDomain}</span>
              </Row>
            </dl>
          )}
        </Card>

        <Card className="p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-base font-semibold">Orphelins</h3>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Ce qui existe chez Cloudflare sans site dans le hub, ou l'inverse.
                {r?.checkedAt ? ` Dernière vérification : ${formatDateTime(r.checkedAt)}.` : r ? " Jamais vérifié." : ""}
              </p>
            </div>
            <Button variant="secondary" onClick={() => void check()} disabled={checking}>
              <FontAwesomeIcon icon={faMagnifyingGlass} className="h-3.5 w-3.5" aria-hidden />
              {checking ? "Vérification…" : "Vérifier maintenant"}
            </Button>
          </div>

          {orphans.loading ? (
            <p role="status" className="mt-3 text-sm text-[var(--muted)]">
              Lecture…
            </p>
          ) : orphans.error && !r ? (
            <Banner level="error" className="mt-3" action={<Button variant="ghost" onClick={() => void orphans.reload()}>Réessayer</Button>}>
              {orphans.error}
            </Banner>
          ) : r ? (
            <div className="mt-3 space-y-3">
              {r.mode === "fake" ? <Badge tone="amber">Cloudflare simulé</Badge> : null}
              {r.error ? <Banner level="error">{r.error}</Banner> : null}
              {r.checkedAt && r.findings.length === 0 && !r.error ? (
                <p className="flex items-center gap-2 text-sm text-[var(--text)]">
                  <FontAwesomeIcon icon={faCircleCheck} className="h-4 w-4 text-[var(--success)]" aria-hidden />
                  Aucun orphelin.
                </p>
              ) : null}
              {r.findings.length ? (
                <ul className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)]">
                  {r.findings.map((f) => (
                    <li key={`${f.type}:${f.name}`} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
                      <div className="min-w-0">
                        <p className="text-xs text-[var(--muted)]">{FINDING_TYPE[f.type]}</p>
                        <p className="break-all font-mono text-sm text-[var(--text)]">{f.name}</p>
                        <p className="mt-0.5 text-sm text-[var(--muted)]">{f.detail}</p>
                      </div>
                      {f.deletable ? (
                        <Button variant="danger" onClick={() => setToDelete(f)}>
                          Supprimer l'enregistrement
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </Card>
      </div>

      <ConfirmDialog
        open={toDelete !== null}
        title="Supprimer cet enregistrement DNS ?"
        message={
          <>
            <p>
              L'enregistrement <strong className="break-all font-mono">{toDelete?.name}</strong> sera retiré de la zone DNS. Il ne
              correspond à aucun site du hub.
            </p>
            <p className="mt-2 text-[var(--muted)]">{toDelete?.detail}</p>
          </>
        }
        confirmLabel="Supprimer l'enregistrement"
        danger
        busy={deleting}
        onConfirm={() => void remove()}
        onClose={() => setToDelete(null)}
      />
    </section>
  );
}
