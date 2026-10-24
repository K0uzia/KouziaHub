import { useId, useState } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowUpRightFromSquare } from "@fortawesome/free-solid-svg-icons";
import type { SiteDetail } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { formatBytes, formatDateTime, plural } from "@/lib/format";
import { Badge, Card } from "@/components/ui/Card";
import { Switch } from "@/components/ui/Switch";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { IndexingSwitch } from "@/components/sites/IndexingSwitch";

/** Panneau de synthèse de la fiche : adresse, client, version servie, fichiers de travail, mise en ligne et indexation. */
export function SummaryPanel({ site, onSite }: { site: SiteDetail; onSite: (s: SiteDetail) => void }) {
  const noteId = useId();
  const [confirmOff, setConfirmOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = site.operation?.status === "RUNNING";
  const online = site.state === "ONLINE";
  // Remise en ligne en attente ou en erreur de certificat : l'adresse est posée, « couper » la retire.
  const addressPending = site.state === "OFFLINE" && site.domainStatus !== "NONE";
  const locked = running || site.state === "CREATING" || site.state === "DELETING";

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      const updated = await api<SiteDetail>(`/api/sites/${site.id}/${next ? "enable" : "disable"}`, { method: "POST" });
      onSite(updated);
      setConfirmOff(false);
      toast.success(
        next
          ? `Remise en ligne lancée : ${site.hostname} répondra d'ici quelques minutes (certificat).`
          : `Mise hors ligne lancée : ${site.hostname} ne répondra plus.`,
      );
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const note = site.state === "CREATING"
    ? "Disponible une fois la création terminée."
    : site.state === "DELETING"
      ? "Suppression en cours."
      : running
        ? "Une opération est en cours : l'interrupteur revient à la fin."
    : online
      ? "Couper le site retire son adresse : elle ne répondra plus."
      : addressPending
        ? "Remise en ligne demandée, certificat en attente. Couper le site retire son adresse."
      : "L'adresse ne répond pas. La remise en ligne prend quelques minutes (certificat).";

  return (
    <Card className="p-4 sm:p-5">
      <h2 className="mb-3 text-base font-semibold">Synthèse</h2>
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-xs text-[var(--muted)]">Adresse</dt>
          <dd className="mt-0.5 break-all font-mono text-[var(--text)]">{site.hostname}</dd>
        </div>
        {site.php ? (
          <div>
            <dt className="text-xs text-[var(--muted)]">Hébergement</dt>
            <dd className="mt-0.5 text-[var(--text)]">
              Serveur des sites PHP, PHP {site.php.version}
              <span className="block text-xs text-[var(--muted)]">
                Dossier public : <span className="font-mono">{site.php.publicDir ? `${site.php.publicDir}/` : "racine"}</span>
                {site.php.persistentDirs.length ? (
                  <>
                    , persistants : <span className="font-mono">{site.php.persistentDirs.map((d) => `${d}/`).join(", ")}</span>
                  </>
                ) : null}
              </span>
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-xs text-[var(--muted)]">Client</dt>
          <dd className="mt-0.5 min-w-0">
            {site.kind === "PERSO" ? (
              <Badge tone="violet">Perso</Badge>
            ) : site.erpClientUrl ? (
              <a href={site.erpClientUrl} target="_blank" rel="noopener noreferrer" className="link inline-flex min-h-6 items-center gap-1.5 break-words">
                {site.clientName ?? "Fiche du client"}
                <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3 w-3 shrink-0" aria-hidden />
                <span className="sr-only">(fiche dans l'ERP, nouvel onglet)</span>
              </a>
            ) : (
              <span className="text-[var(--text)]">{site.clientName ?? "Client non lu (ERP indisponible)"}</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--muted)]">Version servie</dt>
          <dd className="mt-0.5 text-[var(--text)]">
            {site.currentVersion ? (
              <>
                Version {site.currentVersion.number}
                {site.currentVersion.publishedAt ? (
                  <span className="block text-xs text-[var(--muted)]">publiée le {formatDateTime(site.currentVersion.publishedAt)}</span>
                ) : null}
              </>
            ) : (
              <span className="text-[var(--muted)]">Aucune</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--muted)]">Fichiers de travail</dt>
          <dd className="mt-0.5 text-[var(--text)]">
            {plural(site.fileCount, "fichier", "fichiers")}, {formatBytes(site.totalBytes)}
            {site.workingDirty ? <span className="block text-xs text-[var(--warning)]">Modifications non publiées</span> : null}
          </dd>
        </div>
      </dl>

      <div className="mt-4 border-t border-[var(--border)] pt-3">
        <Switch
          checked={online || addressPending}
          onChange={(next) => (next ? void toggle(true) : setConfirmOff(true))}
          label="Site accessible"
          stateLabels={{ on: "En ligne", off: "Hors ligne" }}
          disabled={locked || busy}
          describedBy={noteId}
        />
        <p id={noteId} className="mt-1 text-xs text-[var(--muted)]">
          {note}
        </p>
      </div>
      <IndexingSwitch site={site} onSite={onSite} />

      <ConfirmDialog
        open={confirmOff}
        title={`Mettre ${site.hostname} hors ligne ?`}
        message={
          <>
            <p>
              L'adresse <strong className="font-mono">{site.hostname}</strong> ne répondra plus : les visiteurs n'y verront plus rien.
            </p>
            <p className="mt-2 text-[var(--muted)]">
              Les fichiers et les versions sont gardés. Vous pourrez remettre le site en ligne à tout moment ; il faudra alors
              quelques minutes pour le certificat.
            </p>
          </>
        }
        confirmLabel="Mettre hors ligne"
        danger
        busy={busy}
        onConfirm={() => void toggle(false)}
        onClose={() => setConfirmOff(false)}
      />
    </Card>
  );
}
