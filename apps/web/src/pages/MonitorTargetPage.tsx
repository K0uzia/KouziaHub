import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import type { MonitorTargetDetail, MonitorTargetEntry } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { useResource } from "@/lib/useResource";
import { useTitle } from "@/lib/useTitle";
import { Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Button, ButtonLink } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TargetPanel } from "@/components/monitor/TargetPanel";

/** Fiche d'une adresse surveillée hors site du hub (domaine Cloudflare ou ajouté à la main). */
export function MonitorTargetPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const detail = useResource<MonitorTargetDetail>(`/api/monitor/targets/${id}?days=30`);
  const [target, setTarget] = useState<MonitorTargetEntry | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const t = target ?? detail.data;
  useTitle(t?.label ?? "Surveillance");

  async function remove() {
    if (!t) return;
    setBusy(true);
    try {
      await api(`/api/monitor/targets/${t.id}`, { method: "DELETE" });
      toast.success(`${t.hostname} n'est plus surveillé`);
      navigate("/surveillance", { replace: true });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (detail.loading) {
    return (
      <p role="status" className="py-16 text-center text-sm text-[var(--muted)]">
        Chargement…
      </p>
    );
  }
  if (!t) {
    return (
      <>
        <PageHeader title="Adresse introuvable" back={{ to: "/surveillance", label: "Surveillance" }} />
        <Card>
          <EmptyState
            title={detail.error ?? "Cette adresse n'est pas surveillée."}
            action={<ButtonLink to="/surveillance">Retour à la surveillance</ButtonLink>}
          />
        </Card>
      </>
    );
  }

  return (
    <div className="page-narrow">
      <PageHeader
        back={{ to: "/surveillance", label: "Surveillance" }}
        title={t.label}
        actions={
          t.source !== "site" ? (
            <Button variant="danger" onClick={() => setConfirm(true)}>
              Retirer de la surveillance
            </Button>
          ) : (
            <ButtonLink to={`/sites/${t.siteId}?tab=surveillance`} variant="secondary">
              Fiche du site
            </ButtonLink>
          )
        }
      />
      <TargetPanel target={t} onChange={setTarget} />
      <ConfirmDialog
        open={confirm}
        title={`Retirer ${t.hostname} ?`}
        message="Plus aucun contrôle ni alerte pour cette adresse. L'historique et les rapports sont supprimés avec elle."
        confirmLabel="Retirer de la surveillance"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setConfirm(false)}
      />
    </div>
  );
}
