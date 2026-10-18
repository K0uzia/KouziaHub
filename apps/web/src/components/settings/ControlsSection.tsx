import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronRight, faMagnifyingGlass } from "@fortawesome/free-solid-svg-icons";
import type { OrphanFinding, OrphanReport, SystemStatus } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { cloudflareStatus, erpStatus } from "@/lib/settingsStatus";
import { useResource, type Resource } from "@/lib/useResource";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Tile } from "@/components/ui/Tile";

const FINDING_TYPE: Record<OrphanFinding["type"], string> = {
  dns: "Enregistrement DNS",
  project: "Projet Cloudflare",
  site: "Site du hub",
};

/** Les trois jetons Cloudflare et leurs droits (README, chapitre 2) : rien de plus. */
const TOKENS: Array<{ name: string; rights: string; command: string }> = [
  {
    name: "Jeton API du hub",
    rights: "Account > Cloudflare Pages > Edit ; Zone > DNS > Edit et Zone > Cache Purge > Purge (zone du hub).",
    command: "hubctl secrets api",
  },
  {
    name: "Jeton de déploiement de la veille",
    rights: "Account > Workers Scripts > Edit ; Account > D1 > Edit. Jamais enregistré.",
    command: "hubctl veille deploy",
  },
  {
    name: "Jeton de lecture des zones (facultatif)",
    rights: "Zone > Zone > Read, toutes les zones.",
    command: "hubctl secrets veille",
  },
];

/** Dépliant d'une tuile : résumé cliquable, détail long dessous (sans perdre de fonction). */
export function TileDetails({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="code-details">
      <summary className="code-summary">
        <FontAwesomeIcon icon={faChevronRight} className="code-chevron h-3 w-3 shrink-0 text-[var(--muted)]" aria-hidden />
        {summary}
      </summary>
      <div className="space-y-2 pb-1 text-sm">{children}</div>
    </details>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      <dt className="text-xs text-[var(--muted)]">{label}</dt>
      <dd className="text-sm text-[var(--text)]">{children}</dd>
    </div>
  );
}

/** Tuile Cloudflare et jetons : mode, projets, services, orphelins (vérification et suppression), droits attendus. */
export function CloudflareTile({ system }: { system: Resource<SystemStatus> }) {
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

  return (
    <Tile id="controles" className="scroll-mt-4" title="Cloudflare et jetons" level={2} status={cloudflareStatus({ data: s, error: system.error }, r)}>
      {s ? (
        <dl className="space-y-1">
          <Fact label="Mode">{s.cloudflare.mode === "real" ? "Compte réel" : "Simulé (démonstration)"}</Fact>
          <Fact label="Projets Pages">
            {s.cloudflare.projectsUsed == null ? `inconnu, limite ${s.cloudflare.projectsLimit}` : `${s.cloudflare.projectsUsed} / ${s.cloudflare.projectsLimit}`}
          </Fact>
          <Fact label="Domaine des sites">
            <span className="font-mono">*.{s.sitesDomain}</span>
          </Fact>
        </dl>
      ) : system.error ? (
        <Button variant="ghost" className="self-start" onClick={() => void system.reload()}>
          Réessayer
        </Button>
      ) : (
        <p role="status" className="text-sm text-[var(--muted)]">
          Lecture…
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => void check()} disabled={checking}>
          <FontAwesomeIcon icon={faMagnifyingGlass} className="h-3.5 w-3.5" aria-hidden />
          {checking ? "Vérification…" : "Vérifier les orphelins"}
        </Button>
      </div>

      <TileDetails summary={`Orphelins${r ? ` (${r.findings.length})` : ""}`}>
        <p className="text-[var(--muted)]">
          Ce qui existe chez Cloudflare sans site dans le hub, ou l'inverse.
          {r?.checkedAt ? ` Dernière vérification : ${formatDateTime(r.checkedAt)}.` : r ? " Jamais vérifié." : ""}
        </p>
        {orphans.error && !r ? <p className="text-[var(--danger)]">{orphans.error}</p> : null}
        {r?.error ? <p className="text-[var(--danger)]">{r.error}</p> : null}
        {r?.checkedAt && r.findings.length === 0 && !r.error ? <p>Aucun orphelin.</p> : null}
        {r?.findings.length ? (
          <ul className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)]">
            {r.findings.map((f) => (
              <li key={`${f.type}:${f.name}`} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs text-[var(--muted)]">{FINDING_TYPE[f.type]}</p>
                  <p className="break-all font-mono text-[var(--text)]">{f.name}</p>
                  <p className="mt-0.5 text-[var(--muted)]">{f.detail}</p>
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
      </TileDetails>

      {s ? (
        <TileDetails summary="Services du hub">
          <dl className="space-y-1">
            <Fact label="Vignettes">{s.thumbnails.capture ? "Capture automatique" : `Indisponible${s.thumbnails.reason ? ` : ${s.thumbnails.reason}` : ""}`}</Fact>
            <Fact label="Mesure de vitesse">{s.speed.available ? "Disponible" : `Indisponible${s.speed.reason ? ` : ${s.speed.reason}` : ""}`}</Fact>
          </dl>
        </TileDetails>
      ) : null}

      <TileDetails summary="Droits attendus des jetons">
        <ul className="space-y-2">
          {TOKENS.map((t) => (
            <li key={t.name}>
              <p className="font-medium text-[var(--text)]">{t.name}</p>
              <p className="text-[var(--muted)]">{t.rights}</p>
              <p className="text-xs text-[var(--muted)]">
                Posé par <code className="font-mono">{t.command}</code>
              </p>
            </li>
          ))}
        </ul>
      </TileDetails>

      <ConfirmDialog
        open={toDelete !== null}
        title="Supprimer cet enregistrement DNS ?"
        message={
          <>
            <p>
              L'enregistrement <strong className="break-all font-mono">{toDelete?.name}</strong> sera retiré de la zone DNS. Il ne correspond
              à aucun site du hub.
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
    </Tile>
  );
}

/** Tuile Lien ERP : mode et joignabilité ; la marche à suivre est dans le README (chapitre 2 d). */
export function ErpTile({ system }: { system: Resource<SystemStatus> }) {
  const s = system.data;
  return (
    <Tile title="Lien ERP" level={2} status={erpStatus({ data: s, error: system.error })}>
      <p className="text-sm text-[var(--muted)]">
        Le hub lit seulement le nom, le numéro et le type de chaque client, sur le réseau local, jamais son adresse ni ses coordonnées.
      </p>
      {s && s.erp.mode === "fake" ? (
        <TileDetails summary="Poser le lien">
          <ol className="list-decimal space-y-1 pl-5 text-[var(--text)]">
            <li>Côté ERP : écouteur dédié sur le port 3100, ouvert au seul CT du hub (pare-feu Proxmox).</li>
            <li>Un secret partagé, posé à l'identique dans le .env de l'ERP.</li>
            <li>
              Dans le CT du hub : <code className="font-mono">hubctl secrets erp</code>.
            </li>
          </ol>
        </TileDetails>
      ) : null}
    </Tile>
  );
}
