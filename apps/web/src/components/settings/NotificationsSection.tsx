import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { PushDevice } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { currentSubscription, disablePush, enablePush, pushSupport } from "@/lib/push";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronRight } from "@fortawesome/free-solid-svg-icons";
import { Tile } from "@/components/ui/Tile";
import { notificationsStatus } from "@/lib/settingsStatus";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/**
 * Tuile Notifications : états et textes repris de l'ERP (Réglages > Notifications), adaptés au hub ;
 * liste des appareils dans un dépliant.
 */
export function NotificationsSection() {
  const support = pushSupport();
  const [publicKey, setPublicKey] = useState<string | null | undefined>(undefined);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [thisEndpoint, setThisEndpoint] = useState<string | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | null>(
    typeof Notification === "undefined" ? null : Notification.permission,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<PushDevice | null>(null);

  const load = useCallback(async () => {
    try {
      const [cfg, list] = await Promise.all([api<{ publicKey: string | null }>("/api/push/config"), api<PushDevice[]>("/api/push/devices")]);
      setPublicKey(cfg.publicKey);
      setDevices(list);
      setThisEndpoint((await currentSubscription().catch(() => null))?.endpoint ?? null);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e, "Chargement impossible"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const thisDevice = devices.find((d) => d.endpoint === thisEndpoint) ?? null;

  async function enable() {
    if (!publicKey) return;
    setBusy(true);
    try {
      const result = await enablePush(publicKey);
      setPermission(result.permission);
      if (result.permission === "granted") toast.success("Notifications activées sur cet appareil");
      else toast.error("Notifications refusées : autorisez-les dans les réglages du navigateur.");
      await load();
    } catch (e) {
      toast.error(errorMessage(e, "Activation impossible"));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      await disablePush(devices);
      toast.success("Notifications désactivées sur cet appareil");
      await load();
    } catch (e) {
      toast.error(errorMessage(e, "Désactivation impossible"));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    try {
      const r = await api<{ sent: number; failed: number }>("/api/push/test", { method: "POST" });
      toast.success(`Notification de test envoyée à ${r.sent} appareil${r.sent > 1 ? "s" : ""}`);
      await load();
    } catch (e) {
      toast.error(errorMessage(e, "Envoi impossible"));
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(d: PushDevice) {
    try {
      // Cet appareil : le navigateur est aussi désabonné (sinon il garderait un abonnement inutile).
      if (d.endpoint === thisEndpoint) await (await currentSubscription())?.unsubscribe();
      await api(`/api/push/devices/${d.id}`, { method: "DELETE" });
      toast.success(`« ${d.label} » ne recevra plus de notifications`);
      setRemoving(null);
      await load();
    } catch (e) {
      toast.error(errorMessage(e, "Retrait impossible"));
    }
  }

  return (
    <Tile
      id="notifications"
      className="scroll-mt-4"
      title="Notifications"
      level={2}
      tip="push"
      status={notificationsStatus({ data: publicKey === undefined ? null : { publicKey, devices: devices.length }, error: loadError })}
    >
      {loadError ? (
        <Button variant="secondary" className="self-start" onClick={() => void load()}>
          Réessayer
        </Button>
      ) : publicKey === undefined ? (
        <div role="status" aria-busy="true" className="h-11 animate-pulse rounded-[var(--radius)] bg-[var(--surface-raised)]">
          <span className="sr-only">Chargement des notifications…</span>
        </div>
      ) : support === "insecure" ? (
        <p className="text-sm text-[var(--warning)]">
          Les notifications push ne fonctionnent qu'en https : ouvrez le hub par https://hub.kouzia.com (ou http://localhost sur
          l'ordinateur du hub), pas par l'adresse IP du réseau local (make dev-lan).
        </p>
      ) : support === "unsupported" ? (
        <p className="text-sm text-[var(--warning)]">
          Ce navigateur ne gère pas les notifications push. Sur Android : Chrome ou Samsung Internet ; sur iPhone, ajoutez d'abord le hub
          à l'écran d'accueil.
        </p>
      ) : !publicKey ? (
        <p className="text-sm text-[var(--muted)]">Une fois les clés posées, activez les notifications ici, sur chaque téléphone.</p>
      ) : permission === "denied" ? (
        <p className="text-sm text-[var(--warning)]">
          Notifications bloquées pour ce site : autorisez-les dans les réglages du navigateur (cadenas, Autorisations, Notifications),
          puis revenez ici.
        </p>
      ) : thisDevice ? (
        <>
          <p className="text-sm text-[var(--muted)]">
            Activées sur cet appareil (<span className="font-medium text-[var(--text)]">{thisDevice.label}</span>).
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void test()} disabled={busy}>
              Envoyer une notification de test
            </Button>
            <Button variant="secondary" onClick={() => void disable()} disabled={busy}>
              Désactiver sur cet appareil
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-xs text-[var(--muted)]">
            Le navigateur demande l'autorisation. Sur téléphone, ajoutez aussi le hub à l'écran d'accueil pour l'ouvrir comme une
            application.
          </p>
          <Button className="self-start" onClick={() => void enable()} disabled={busy}>
            {busy ? "Activation…" : "Activer sur cet appareil"}
          </Button>
        </>
      )}

      {devices.length > 0 ? (
        <details className="code-details mt-1">
          <summary className="code-summary">
            <FontAwesomeIcon icon={faChevronRight} className="code-chevron h-3 w-3 shrink-0 text-[var(--muted)]" aria-hidden />
            Appareils ({devices.length})
          </summary>
          <ul className="divide-y divide-[var(--border)]">
            {devices.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {d.label}
                    {d.endpoint === thisEndpoint ? <span className="ml-2 text-xs text-[var(--muted)]">(cet appareil)</span> : null}
                  </p>
                  <p className="text-xs text-[var(--muted)]">
                    Ajouté le {formatDate(d.createdAt)}
                    {d.lastSuccessAt ? `, dernière notification le ${formatDate(d.lastSuccessAt)}` : ""}
                    {d.lastError ? `, dernière erreur : ${d.lastError}` : ""}
                  </p>
                </div>
                <Button variant="danger-ghost" onClick={() => setRemoving(d)}>
                  Retirer
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <ConfirmDialog
        open={Boolean(removing)}
        title="Retirer cet appareil"
        message={`« ${removing?.label ?? ""} » ne recevra plus de notifications push. Vous pourrez les réactiver depuis cet appareil.`}
        confirmLabel="Retirer"
        danger
        onConfirm={() => removing && void remove(removing)}
        onClose={() => setRemoving(null)}
      />
    </Tile>
  );
}
