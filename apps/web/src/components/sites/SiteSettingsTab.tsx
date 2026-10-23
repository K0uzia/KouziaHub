import { useId, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTrashCan } from "@fortawesome/free-solid-svg-icons";
import type { ErpClient, SiteDetail, UpdateSiteInput } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { ClientPicker } from "@/components/sites/ClientPicker";
import { PurgeFilesCard } from "@/components/sites/PurgeFilesCard";

export function SiteSettingsTab({ site, onSite, onPurged }: { site: SiteDetail; onSite: (s: SiteDetail) => void; onPurged: () => void }) {
  const navigate = useNavigate();
  const ids = useId();
  const [label, setLabel] = useState(site.label ?? "");
  const [labelError, setLabelError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"label" | "client" | null>(null);
  const [changingClient, setChangingClient] = useState(false);
  const [client, setClient] = useState<ErpClient | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const locked = site.state === "DELETING";

  async function patch(body: UpdateSiteInput, what: "label" | "client", ok: string) {
    setSaving(what);
    try {
      const updated = await api<SiteDetail>(`/api/sites/${site.id}`, { method: "PATCH", json: body });
      onSite(updated);
      toast.success(ok);
      return true;
    } catch (err) {
      const message = errorMessage(err, "Enregistrement impossible.");
      if (what === "label") setLabelError(message);
      toast.error(message);
      return false;
    } finally {
      setSaving(null);
    }
  }

  async function saveLabel(e: FormEvent) {
    e.preventDefault();
    const trimmed = label.trim();
    if (site.kind === "PERSO" && !trimmed) {
      setLabelError("Un site perso garde un nom.");
      return;
    }
    setLabelError(null);
    await patch({ label: trimmed || null }, "label", "Libellé enregistré");
  }

  async function saveClient() {
    if (!client) return;
    if (await patch({ erpClientId: client.id }, "client", `Site lié à ${client.displayName}`)) {
      setChangingClient(false);
      setClient(null);
    }
  }

  async function onDelete(e: FormEvent) {
    e.preventDefault();
    if (confirmText.trim() !== site.slug) {
      setDeleteError(`Saisissez exactement « ${site.slug} ».`);
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await api<SiteDetail>(`/api/sites/${site.id}`, { method: "DELETE", json: { confirm: site.slug } });
      toast.success(`Suppression de ${site.hostname} lancée`);
      navigate("/", { replace: true });
    } catch (err) {
      const message = errorMessage(err, "Suppression impossible.");
      setDeleteError(message);
      toast.error(message);
    } finally {
      setDeleting(false);
    }
  }

  const labelDirty = label.trim() !== (site.label ?? "");

  return (
    <div className="space-y-5">
      <Card className="p-4 sm:p-5">
        <form onSubmit={saveLabel} noValidate className="space-y-4">
          <h2 className="text-base font-semibold">Libellé</h2>
          <Field
            label={site.kind === "PERSO" ? "Nom du site" : "Libellé (facultatif)"}
            hint={site.kind === "CLIENT" ? "Vide : le nom du client est affiché." : undefined}
            error={labelError ?? undefined}
          >
            <Input value={label} maxLength={80} autoComplete="off" onChange={(e) => setLabel(e.target.value)} disabled={locked} />
          </Field>
          <Button type="submit" variant="secondary" disabled={!labelDirty || saving !== null || locked}>
            {saving === "label" ? "Enregistrement…" : "Enregistrer le libellé"}
          </Button>
        </form>
      </Card>

      <Card className="p-4 sm:p-5">
        <h2 className="text-base font-semibold">Client lié</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          {site.kind === "PERSO"
            ? "Site perso : lié à aucun client de l'ERP."
            : site.clientName
              ? `Lié à ${site.clientName}.`
              : "Lié à un client que l'ERP ne renvoie pas pour l'instant."}
        </p>
        {changingClient ? (
          <div className="mt-4 space-y-3">
            <ClientPicker value={client} onChange={setClient} label="Nouveau client" />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void saveClient()} disabled={!client || saving !== null}>
                {saving === "client" ? "Enregistrement…" : "Lier ce client"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setChangingClient(false);
                  setClient(null);
                }}
              >
                Annuler
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4">
            <Button variant="secondary" onClick={() => setChangingClient(true)} disabled={locked}>
              {site.kind === "PERSO" ? "Lier à un client" : "Changer de client"}
            </Button>
          </div>
        )}
      </Card>


      <PurgeFilesCard site={site} onPurged={onPurged} />

      <Card className="border-[var(--danger)]/40 p-4 sm:p-5">
        <form onSubmit={onDelete} noValidate className="space-y-4" aria-labelledby={`${ids}-del`}>
          <h2 id={`${ids}-del`} className="text-base font-semibold text-[var(--danger)]">
            Supprimer le site
          </h2>
          <div className="space-y-2 text-sm text-[var(--text)]">
            <p>
              L'adresse <strong className="font-mono">{site.hostname}</strong> cessera de répondre, le projet Cloudflare est retiré.
            </p>
            <p>Les fichiers de travail et toutes les versions sont supprimés. Cette action ne peut pas être annulée.</p>
          </div>
          <Field label={`Pour confirmer, saisissez le sous-domaine : ${site.slug}`} error={deleteError ?? undefined}>
            <Input
              value={confirmText}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono"
              disabled={locked}
              onChange={(e) => {
                setConfirmText(e.target.value);
                setDeleteError(null);
              }}
            />
          </Field>
          <Button type="submit" variant="danger" disabled={deleting || locked || confirmText.trim() !== site.slug}>
            <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" aria-hidden />
            {deleting ? "Suppression…" : `Supprimer ${site.hostname}`}
          </Button>
        </form>
      </Card>
    </div>
  );
}
