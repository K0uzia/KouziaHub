import type { PhpServerStatus, PhpServiceState } from "@hub/contract";
import { formatBytes, formatDateTime, plural } from "@/lib/format";
import { phpServerStatus } from "@/lib/settingsStatus";
import { useResource } from "@/lib/useResource";
import { Button } from "@/components/ui/Button";
import { Tile } from "@/components/ui/Tile";
import { TileDetails } from "@/components/settings/ControlsSection";

const SERVICE_TEXT: Record<PhpServiceState, string> = { running: "en marche", stopped: "arrêté", absent: "non installé" };

/** Serveur des sites PHP (docs/cadrage.md, section 11) : état du CT, lu par son agent sur le réseau local. */
export function PhpServerTile() {
  const server = useResource<PhpServerStatus>("/api/php/serveur");
  const d = server.data;
  const s = d && d.configured && d.reachable ? d.state : null;
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
