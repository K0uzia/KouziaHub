import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { PhpServerStatus, PhpServiceState } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { formatBytes, formatDateTime, plural } from "@/lib/format";
import { phpServerStatus } from "@/lib/settingsStatus";
import { useResource } from "@/lib/useResource";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Tile } from "@/components/ui/Tile";
import { TileDetails } from "@/components/settings/ControlsSection";

const SERVICE_TEXT: Record<PhpServiceState, string> = { running: "en marche", stopped: "arrêté", absent: "non installé" };

/** Serveur des sites PHP (docs/cadrage.md, section 11) : état du CT, lu par son agent sur le réseau local. */
export function PhpServerTile() {
  const [watching, setWatching] = useState(false);
  // Mise à jour en cours : état relu toutes les 3 s jusqu'à la fin (l'agent redémarre entre-temps).
  const server = useResource<PhpServerStatus>("/api/php/serveur", watching ? 3000 : null);
  const d = server.data;
  const job = d?.update ?? null;
  const updating = watching || job?.running === true;
  const s = d && d.configured && d.reachable ? d.state : null;
  const available = d && d.configured && d.reachable ? d.scriptsAvailable : null;
  const installed = s?.scripts?.digest ?? null;
  const upToDate = Boolean(installed && available && installed === available);
  const failure = job && !job.running && job.ok === false ? job.log : null;

  useEffect(() => {
    if (!watching || !job || job.running) return;
    setWatching(false);
    if (job.ok) toast.success("Serveur des sites PHP à jour");
  }, [watching, job]);

  // Même opération que « hubctl update » : scripts du dépôt du hub envoyés à l'agent, installés, agent relancé.
  async function onUpdate() {
    try {
      await api<{ started: true }>("/api/php/serveur/mise-a-jour", { method: "POST" });
      setWatching(true);
      void server.reload();
    } catch (err) {
      toast.error(errorMessage(err, "Mise à jour impossible."));
    }
  }
  return (
    <Tile title="Serveur des sites PHP" level={2} id="serveur-php" status={phpServerStatus({ data: d, error: server.error })}>
      <p className="text-sm text-[var(--muted)]">
        CT à part sur le Proxmox, sans accès au réseau local. Le hub le pilote par son agent, jamais par Internet.
      </p>
      {s ? (
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="text-[var(--muted)]">PHP</dt>
          <dd>{s.php.length ? s.php.join(", ") : "aucun"}</dd>
          <dt className="text-[var(--muted)]">Services</dt>
          <dd>
            nginx {SERVICE_TEXT[s.services.nginx]}, MariaDB {SERVICE_TEXT[s.services.mariadb]}, tunnel {SERVICE_TEXT[s.services.tunnel]}, pare-feu du CT{" "}
            {SERVICE_TEXT[s.services.firewall]}
          </dd>
          <dt className="text-[var(--muted)]">Limites par site</dt>
          <dd>
            {s.cgroups.result === "ok" ? "effectives" : s.cgroups.result === "echec" ? "non effectives (limites de PHP et du CT seulement)" : "pas encore contrôlées"}
            {s.cgroups.checkedAt ? <span className="text-[var(--muted)]">, contrôle du {s.cgroups.checkedAt}</span> : null}
          </dd>
          <dt className="text-[var(--muted)]">Scripts du CT</dt>
          <dd>
            {s.scripts === null
              ? "agent trop ancien pour se mettre à jour : une dernière fois la section 11.5 du README"
              : installed
                ? `installés ${installed.slice(0, 12)}${s.scripts.installedAt ? ` le ${formatDateTime(s.scripts.installedAt)}` : ""}`
                : "jamais mis à jour par le hub"}
            {available && !upToDate ? <span className="text-[var(--muted)]">, disponibles {available.slice(0, 12)}</span> : null}
            {upToDate ? <span className="text-[var(--muted)]"> (à jour)</span> : null}
            {s.scripts?.result === "echec" ? <span className="text-[var(--danger)]">, dernière mise à jour en échec</span> : null}
          </dd>
          <dt className="text-[var(--muted)]">Mises à jour</dt>
          <dd>{s.lastUpgrade ? `dernière le ${s.lastUpgrade}` : "jamais lancées (kouziaphpctl upgrade)"}</dd>
          <dt className="text-[var(--muted)]">Sites</dt>
          <dd>
            {plural(s.sites, "site", "sites")}
            {s.disk ? <span className="text-[var(--muted)]">, {formatBytes(s.disk.freeBytes)} libres sur {formatBytes(s.disk.totalBytes)}</span> : null}
          </dd>
          <dt className="text-[var(--muted)]">Système</dt>
          <dd className="text-[var(--muted)]">
            Alpine {s.alpine ?? "?"}, agent {s.agentVersion} (Node {s.node}), heure du CT {formatDateTime(s.time)}
          </dd>
        </dl>
      ) : null}
      {s && s.scripts !== null ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant={upToDate ? "secondary" : "primary"} onClick={() => void onUpdate()} disabled={updating}>
            {updating ? "Mise à jour en cours…" : upToDate ? "Réinstaller les scripts" : "Mettre à jour le serveur des sites PHP"}
          </Button>
          {updating ? <span className="text-sm text-[var(--muted)]">Jusqu'à quelques minutes (paquets, services) ; l'agent redémarre à la fin.</span> : null}
        </div>
      ) : null}
      {failure ? (
        <Banner level="error" role="alert">
          Mise à jour en échec : l'installation d'avant est remise. Journal :
          <pre tabIndex={0} aria-label="Journal de la mise à jour" className="code-block mt-2 max-h-64 whitespace-pre-wrap">
            {failure}
          </pre>
        </Banner>
      ) : null}
      {d && !d.configured ? (
        <TileDetails summary="Installer">
          <ol className="list-decimal space-y-1 pl-5 text-[var(--text)]">
            <li>Créer le CT, son pare-feu Proxmox et son tunnel (README, section 11).</li>
            <li>Régler l'agent et poser le même secret dans les deux CT, depuis le Shell du nœud Proxmox (README, section 11.8).</li>
          </ol>
        </TileDetails>
      ) : null}
      {server.error || (d && d.configured && !d.reachable) ? (
        <Button variant="secondary" onClick={() => void server.reload()}>
          Réessayer
        </Button>
      ) : null}
    </Tile>
  );
}
