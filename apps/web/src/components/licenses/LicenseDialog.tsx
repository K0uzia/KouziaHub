import { useEffect, useId, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCopy, faRotate } from "@fortawesome/free-solid-svg-icons";
import type { LicenseDetail, LicenseSummary, UpdateLicenseInput } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatDay } from "@/lib/format";
import { LICENCE_JOURNAL, remainingText, sameHolder, STATUS, validityText } from "@/lib/licenses";
import { useResource } from "@/lib/useResource";
import { Modal } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { ErpClientField, type LinkedClient } from "@/components/licenses/ErpClientField";
import { KeyBox } from "@/components/licenses/KeyBox";

/**
 * Détail d'une clé : la chaîne à copier, ce qui se modifie (client, contact, notes), l'historique du même client ou
 * de la même entreprise. Nom et dates sont signés : pour les changer, on émet une nouvelle clé (« Renouveler »).
 */
export function LicenseDialog({
  licenseId,
  softwareSlug,
  all,
  today,
  canEmit,
  onClose,
  onOpen,
  onUpdated,
  onRenew,
}: {
  licenseId: string | null;
  softwareSlug: string;
  /** Toutes les clés du logiciel (historique). */
  all: LicenseSummary[];
  today: string;
  /** Clé de signature en place : renouvellement possible. */
  canEmit: boolean;
  onClose: () => void;
  /** Ouvre une autre clé de l'historique. */
  onOpen: (id: string) => void;
  onUpdated: (license: LicenseDetail) => void;
  onRenew: (license: LicenseDetail) => void;
}) {
  const ids = useId();
  const detail = useResource<LicenseDetail>(licenseId ? `/api/logiciels/${softwareSlug}/cles/${licenseId}` : null);
  const l = detail.data;
  const [client, setClient] = useState<LinkedClient | null>(null);
  const [contact, setContact] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Formulaire recalé sur la clé lue (ouverture, autre clé de l'historique, enregistrement).
  useEffect(() => {
    if (!l) return;
    setClient(l.erpClientId ? { id: l.erpClientId, name: l.clientName } : null);
    setContact(l.contact ?? "");
    setNotes(l.notes ?? "");
    setSaveError(null);
  }, [l]);

  const dirty =
    l !== null && ((client?.id ?? null) !== l.erpClientId || contact.trim() !== (l.contact ?? "") || notes.trim() !== (l.notes ?? ""));

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!l || !dirty) return;
    const body: UpdateLicenseInput = {};
    if ((client?.id ?? null) !== l.erpClientId) body.erpClientId = client?.id ?? null;
    if (contact.trim() !== (l.contact ?? "")) body.contact = contact.trim() || null;
    if (notes.trim() !== (l.notes ?? "")) body.notes = notes.trim() || null;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api<LicenseDetail>(`/api/logiciels/${softwareSlug}/cles/${l.id}`, { method: "PATCH", json: body });
      detail.setData(updated);
      onUpdated(updated);
      toast.success("Clé mise à jour");
    } catch (err) {
      const message = errorMessage(err, "Enregistrement impossible.");
      setSaveError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  const history = l ? sameHolder(all, l).sort((a, b) => b.emise.localeCompare(a.emise) || b.createdAt.localeCompare(a.createdAt)) : [];

  return (
    <Modal open={licenseId !== null} onClose={saving ? () => undefined : onClose} title={l ? l.entreprise : "Clé de licence"} wide fullScreenMobile>
      {detail.loading ? (
        <p role="status" className="py-10 text-center text-sm text-[var(--muted)]">
          Lecture de la clé…
        </p>
      ) : detail.error && !l ? (
        <Banner level="error" action={<Button variant="ghost" onClick={() => void detail.reload()}>Réessayer</Button>}>
          {detail.error}
        </Banner>
      ) : l ? (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Badge tone={STATUS[l.status].tone}>{STATUS[l.status].label}</Badge>
            <span className="text-sm text-[var(--muted)]">{remainingText(l.expire, today)}</span>
          </div>
          <p className="text-sm text-[var(--text)]">{validityText(l)}.</p>

          <div className="space-y-2">
            <KeyBox value={l.cle} />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void copyText(l.cle, "Clé copiée")}>
                <FontAwesomeIcon icon={faCopy} className="h-3.5 w-3.5" aria-hidden />
                Copier la clé
              </Button>
              <Button variant="secondary" disabled={!canEmit} onClick={() => onRenew(l)}>
                <FontAwesomeIcon icon={faRotate} className="h-3.5 w-3.5" aria-hidden />
                Renouveler
              </Button>
            </div>
            <p className="max-w-[65ch] text-sm text-[var(--muted)]">
              Pour changer le nom ou la date, émettez une nouvelle clé. L'ancienne reste valable jusqu'à son expiration.
              {canEmit ? "" : " Émission impossible pour l'instant : la clé de signature n'est pas en place sur le serveur."}
            </p>
          </div>

          <form onSubmit={onSave} noValidate className="space-y-4 border-t border-[var(--border)] pt-5" aria-labelledby={`${ids}-edit`}>
            <h3 id={`${ids}-edit`} className="text-base font-semibold">
              Suivi
            </h3>
            <ErpClientField value={client} onChange={setClient} />
            <Field label="Contact (facultatif)" hint="Chiffré sur le hub, jamais écrit dans la clé.">
              <Input value={contact} maxLength={200} autoComplete="off" onChange={(e) => setContact(e.target.value)} />
            </Field>
            <Field label="Notes (facultatif)">
              <Textarea value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            {saveError ? (
              <Banner level="error" role="alert">
                {saveError}
              </Banner>
            ) : null}
            <Button type="submit" variant="secondary" disabled={!dirty || saving}>
              {saving ? "Enregistrement…" : "Enregistrer le suivi"}
            </Button>
          </form>

          <section aria-labelledby={`${ids}-history`} className="space-y-3 border-t border-[var(--border)] pt-5">
            <h3 id={`${ids}-history`} className="text-base font-semibold">
              Historique
            </h3>
            {history.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">Aucune autre clé pour ce client ou cette entreprise.</p>
            ) : (
              <ul className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)]">
                {history.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(h.id)}
                      className="flex min-h-11 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--surface-hover)]"
                    >
                      <span className="min-w-0">
                        <span className="block break-words font-medium text-[var(--text)]">{h.entreprise}</span>
                        <span className="block text-xs text-[var(--muted)]">
                          Du {formatDay(h.emise)} au {formatDay(h.expire)}
                        </span>
                      </span>
                      <Badge tone={STATUS[h.status].tone}>{STATUS[h.status].label}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Link to={LICENCE_JOURNAL} className="link inline-flex min-h-11 items-center text-sm font-medium">
              Journal des clés de licence
            </Link>
          </section>
        </div>
      ) : null}
    </Modal>
  );
}
