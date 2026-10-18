import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBell, faBellSlash, faPaperPlane } from "@fortawesome/free-solid-svg-icons";
import type { PushDevice } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { formatAgo, formatDate } from "@/lib/format";
import { currentSubscription, disablePushHere, enablePush, pushSupport } from "@/lib/push";
import { useResource } from "@/lib/useResource";
import { Badge, Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/** Réglages > Notifications : alertes de surveillance en Web Push sur le téléphone. */
export function NotificationsSection() {
  const ids = useId();
  const config = useResource<{ publicKey: string | null }>("/api/push/config");
  const devices = useResource<PushDevice[]>("/api/push/devices");
  const [support] = useState(pushSupport);
  const [permission, setPermission] = useState<NotificationPermission | null>(
    typeof Notification === "undefined" ? null : Notification.permission,
  );
  const [subscribedHere, setSubscribedHere] = useState<boolean | null>(null);
  /** Adresse d'abonnement de ce navigateur : repère « Cet appareil » dans la liste. */
  const [hereEndpoint, setHereEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState<"enable" | "disable" | "test" | "remove" | null>(null);
  const [removing, setRemoving] = useState<PushDevice | null>(null);

  useEffect(() => {
    void currentSubscription()
      .then((s) => {
        setSubscribedHere(Boolean(s));
        setHereEndpoint(s?.endpoint ?? null);
      })
      .catch(() => setSubscribedHere(false));
  }, []);

  async function enable() {
    const key = config.data?.publicKey;
    if (!key) return;
    setBusy("enable");
    try {
      const res = await enablePush(key);
      setPermission(res.permission);
      if (res.device) {
        setSubscribedHere(true);
        setHereEndpoint(res.device.endpoint);
        devices.setData((prev) => [...(prev ?? []).filter((d) => d.id !== res.device!.id), res.device!]);
        toast.success("Notifications activées sur cet appareil");
      } else if (res.permission === "denied") toast.error("Notifications refusées par le navigateur");
    } catch (err) {
      toast.error(errorMessage(err, "Activation impossible."));
    } finally {
      setBusy(null);
    }
  }

  async function disableHere() {
    setBusy("disable");
    try {
      await disablePushHere();
      // L'abonnement de cet appareil est aussi retiré du hub (sinon il reste dans la liste jusqu'au prochain refus).
      const mine = devices.data?.find((d) => d.endpoint === hereEndpoint);
      if (mine) await api(`/api/push/devices/${mine.id}`, { method: "DELETE" }).catch(() => undefined);
      setSubscribedHere(false);
      setHereEndpoint(null);
      toast.success("Notifications coupées sur cet appareil");
      void devices.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    try {
      const res = await api<{ sent: number; failed: number }>("/api/push/test", { method: "POST" });
      if (res.sent === 0 && res.failed === 0) toast.info("Aucun appareil à prévenir");
      else if (res.failed) toast.warning(`Envoyée à ${res.sent} appareil(s), ${res.failed} échec(s)`);
      else toast.success(`Notification de test envoyée à ${res.sent} appareil(s)`);
      void devices.reload();
    } catch (err) {
      toast.error(errorMessage(err, "Envoi impossible."));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!removing) return;
    setBusy("remove");
    try {
      await api(`/api/push/devices/${removing.id}`, { method: "DELETE" });
      devices.setData((prev) => (prev ?? []).filter((d) => d.id !== removing.id));
      toast.success(`${removing.label} retiré`);
      setRemoving(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const keyMissing = config.data && !config.data.publicKey;
  const list = devices.data ?? [];

  return (
    <section id="notifications" aria-labelledby={`${ids}-title`} className="scroll-mt-4">
      <h2 id={`${ids}-title`} className="mb-3 text-lg font-semibold">
        Notifications
      </h2>
      <Card className="space-y-4 p-4 sm:p-5">
        <p className="text-sm text-[var(--muted)]">
          Les alertes de surveillance (panne, retour, échéance proche) arrivent sur le téléphone, même hub fermé.
        </p>

        {config.loading ? (
          <p role="status" className="text-sm text-[var(--muted)]">
            Lecture…
          </p>
        ) : config.error ? (
          <Banner level="error" action={<Button variant="ghost" onClick={() => void config.reload()}>Réessayer</Button>}>
            {config.error}
          </Banner>
        ) : keyMissing ? (
          <Banner level="warning">
            Les clés de notification ne sont pas encore créées sur le hub : sur le serveur, lancez{" "}
            <code className="font-mono">hubctl push-keys</code>, puis revenez ici.
          </Banner>
        ) : support === "insecure" ? (
          <Banner level="warning">Les notifications demandent une connexion sécurisée (https) : ouvrez le hub par son adresse habituelle.</Banner>
        ) : support === "unsupported" ? (
          <Banner level="warning">
            Ce navigateur ne gère pas les notifications. Sur Android, utilisez Chrome ou Samsung Internet ; sur iPhone, ajoutez d'abord le
            hub à l'écran d'accueil.
          </Banner>
        ) : permission === "denied" ? (
          <Banner level="warning">
            Les notifications sont bloquées pour le hub dans ce navigateur. Autorisez-les dans les réglages du site (icône à gauche de
            l'adresse), puis rechargez la page.
          </Banner>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {subscribedHere ? (
              <>
                <Badge tone="green">
                  <FontAwesomeIcon icon={faBell} className="h-3 w-3" aria-hidden />
                  Activées sur cet appareil
                </Badge>
                <Button variant="ghost" onClick={() => void disableHere()} disabled={busy !== null}>
                  <FontAwesomeIcon icon={faBellSlash} className="h-3.5 w-3.5" aria-hidden />
                  {busy === "disable" ? "Désactivation…" : "Désactiver sur cet appareil"}
                </Button>
              </>
            ) : (
              <Button onClick={() => void enable()} disabled={busy !== null || subscribedHere === null}>
                <FontAwesomeIcon icon={faBell} className="h-3.5 w-3.5" aria-hidden />
                {busy === "enable" ? "Activation…" : "Activer sur ce téléphone"}
              </Button>
            )}
          </div>
        )}

        <div className="space-y-2 border-t border-[var(--border)] pt-4">
          <h3 className="text-sm font-semibold">Appareils qui reçoivent les alertes</h3>
          {devices.loading ? (
            <p role="status" className="text-sm text-[var(--muted)]">
              Lecture…
            </p>
          ) : devices.error && !devices.data ? (
            <Banner level="error" action={<Button variant="ghost" onClick={() => void devices.reload()}>Réessayer</Button>}>
              {devices.error}
            </Banner>
          ) : list.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">Aucun appareil pour l'instant.</p>
          ) : (
            <ul className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)]">
              {list.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0 text-sm">
                    <p className="flex flex-wrap items-center gap-2 text-[var(--text)]">
                      {d.label}
                      {hereEndpoint && d.endpoint === hereEndpoint ? <Badge tone="primary">Cet appareil</Badge> : null}
                    </p>
                    <p className="text-xs text-[var(--muted)]">
                      Ajouté le {formatDate(d.createdAt)}
                      {d.lastSuccessAt ? `, dernière réception ${formatAgo(d.lastSuccessAt)}` : ""}
                    </p>
                    {d.lastError ? <p className="text-xs text-[var(--danger)]">Dernier échec : {d.lastError}</p> : null}
                  </div>
                  <Button variant="danger-ghost" onClick={() => setRemoving(d)} disabled={busy !== null}>
                    Retirer
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Button variant="secondary" onClick={() => void test()} disabled={busy !== null || list.length === 0 || Boolean(keyMissing)}>
            <FontAwesomeIcon icon={faPaperPlane} className="h-3.5 w-3.5" aria-hidden />
            {busy === "test" ? "Envoi…" : "Envoyer une notification de test"}
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={removing !== null}
        title={`Retirer ${removing?.label ?? "cet appareil"} ?`}
        message="Cet appareil ne recevra plus les alertes de surveillance. Vous pourrez le réactiver depuis cet appareil."
        confirmLabel="Retirer l'appareil"
        danger
        busy={busy === "remove"}
        onConfirm={() => void remove()}
        onClose={() => setRemoving(null)}
      />
    </section>
  );
}
