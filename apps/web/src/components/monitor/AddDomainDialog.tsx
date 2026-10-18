import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { CreateMonitorTargetInput, ErpClient, MonitorTargetEntry } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { ClientPicker } from "@/components/sites/ClientPicker";

/** Domaine ajouté à la main (Hostinger ou autre) : adresse, libellé, client facultatif, mot-clé facultatif. */
export function AddDomainDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (t: MonitorTargetEntry) => void;
}) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [keyword, setKeyword] = useState("");
  const [client, setClient] = useState<ErpClient | null>(null);
  const [errors, setErrors] = useState<{ url?: string; label?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUrl("");
    setLabel("");
    setKeyword("");
    setClient(null);
    setErrors({});
  }, [open]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!url.trim()) next.url = "Indiquez l'adresse à surveiller.";
    if (!label.trim()) next.label = "Donnez un nom à ce domaine.";
    setErrors(next);
    if (next.url || next.label) return;
    const body: CreateMonitorTargetInput = {
      url: url.trim(),
      label: label.trim(),
      erpClientId: client?.id ?? null,
      keyword: keyword.trim() || null,
    };
    setBusy(true);
    try {
      const target = await api<MonitorTargetEntry>("/api/monitor/targets", { method: "POST", json: body });
      toast.success(`${target.hostname} est surveillé`);
      onAdded(target);
      onClose();
    } catch (err) {
      const message = errorMessage(err, "Ajout impossible.");
      if ((err as { status?: number }).status === 400 || (err as { status?: number }).status === 409) setErrors({ url: message });
      else setErrors({ form: message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={busy ? () => undefined : onClose} title="Ajouter un domaine" description="Un site hébergé ailleurs (Hostinger…), contrôlé toutes les 5 minutes.">
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        <Field label="Adresse" hint="Exemple : https://www.boulangerie-lefevre.fr" error={errors.url}>
          <Input
            value={url}
            type="url"
            inputMode="url"
            autoComplete="url"
            autoCapitalize="none"
            spellCheck={false}
            className="font-mono"
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <Field label="Nom affiché" error={errors.label}>
          <Input value={label} maxLength={80} autoComplete="off" onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <ClientPicker value={client} onChange={setClient} label="Client de l'ERP (facultatif)" />
        <Field label="Mot-clé à trouver dans la page (facultatif)" hint="Une panne est signalée s'il disparaît de l'accueil.">
          <Input value={keyword} maxLength={120} autoComplete="off" onChange={(e) => setKeyword(e.target.value)} />
        </Field>
        {errors.form ? (
          <p role="alert" className="text-sm text-[var(--danger)]">
            {errors.form}
          </p>
        ) : null}
        <ModalActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Annuler
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Ajout…" : "Surveiller ce domaine"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
