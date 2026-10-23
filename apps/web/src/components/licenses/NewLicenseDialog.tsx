import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCopy } from "@fortawesome/free-solid-svg-icons";
import type { CreateLicenseInput, LicenseDetail } from "@hub/contract";
import { addMonths, DEFAULT_MONTHS, ENTREPRISE_MAX, expiryOf, LICENSE_MONTHS, normalizeEntreprise } from "@hub/license-terms";
import { api, errorMessage } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatDay } from "@/lib/format";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { ErpClientField, type LinkedClient } from "@/components/licenses/ErpClientField";
import { KeyBox } from "@/components/licenses/KeyBox";

export type LicensePrefill = {
  entreprise: string;
  client: LinkedClient | null;
  contact: string | null;
  /** Renouvellement : expiration de la clé d'origine (elle reste valable jusque-là). */
  renewOf?: string;
};

const DATE = "date";

/** Nouvelle clé : client de l'ERP facultatif, nom signé, durée, aperçu de ce qui sera signé, puis la clé à copier. */
export function NewLicenseDialog({
  open,
  onClose,
  softwareSlug,
  softwareName,
  today,
  prefill,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  softwareSlug: string;
  softwareName: string;
  /** Jour de Paris donné par le serveur : jour d'émission de la clé. */
  today: string;
  prefill: LicensePrefill | null;
  onCreated: (license: LicenseDetail) => void;
}) {
  const ids = useId();
  const [client, setClient] = useState<LinkedClient | null>(null);
  const [entreprise, setEntreprise] = useState("");
  const [entrepriseTouched, setEntrepriseTouched] = useState(false);
  const [duration, setDuration] = useState(String(DEFAULT_MONTHS));
  const [expireDate, setExpireDate] = useState("");
  const [contact, setContact] = useState("");
  const [notes, setNotes] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [created, setCreated] = useState<LicenseDetail | null>(null);
  const entrepriseRef = useRef<HTMLInputElement>(null);

  // Ouverture : formulaire vierge, ou prérempli pour un renouvellement.
  useEffect(() => {
    if (!open) return;
    setClient(prefill?.client ?? null);
    setEntreprise(prefill?.entreprise ?? "");
    setEntrepriseTouched(Boolean(prefill));
    setDuration(String(DEFAULT_MONTHS));
    setExpireDate("");
    setContact(prefill?.contact ?? "");
    setNotes("");
    setSubmitted(false);
    setServerError(null);
    setCreated(null);
  }, [open, prefill]);

  const name = normalizeEntreprise(entreprise);
  const expiry = expiryOf(today, duration === DATE ? { expire: expireDate } : { months: Number(duration) });
  const entrepriseError = submitted && !name.ok ? name.reason : null;
  const durationError = submitted && !expiry.ok ? (duration === DATE && !expireDate ? "Choisissez la date de fin." : expiry.reason) : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setServerError(null);
    if (!name.ok) {
      entrepriseRef.current?.focus();
      return;
    }
    if (!expiry.ok) {
      document.getElementById(`${ids}-duration`)?.focus();
      return;
    }
    const body: CreateLicenseInput = {
      entreprise: name.value,
      erpClientId: client?.id ?? null,
      contact: contact.trim() || null,
      notes: notes.trim() || null,
      ...(duration === DATE ? { expire: expireDate } : { months: Number(duration) }),
    };
    setBusy(true);
    try {
      const license = await api<LicenseDetail>(`/api/logiciels/${softwareSlug}/cles`, { method: "POST", json: body });
      setCreated(license);
      onCreated(license);
      toast.success(`Clé émise pour ${license.entreprise}`);
    } catch (err) {
      const message = errorMessage(err, "Émission impossible.");
      setServerError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <Modal open={open} onClose={onClose} title="Clé émise" description={`${softwareName}, à transmettre à ${created.entreprise}.`}>
        <div className="space-y-4">
          <Banner level="info" role="status">
            Clé valable jusqu'au {formatDay(created.expire)} inclus. Elle reste consultable dans la liste.
          </Banner>
          <KeyBox value={created.cle} />
          <ModalActions>
            <Button variant="secondary" onClick={onClose}>
              Fermer
            </Button>
            <Button data-autofocus onClick={() => void copyText(created.cle, "Clé copiée")}>
              <FontAwesomeIcon icon={faCopy} className="h-3.5 w-3.5" aria-hidden />
              Copier la clé
            </Button>
          </ModalActions>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={prefill?.renewOf ? "Renouveler la clé" : "Nouvelle clé"}
      description={`Licence ${softwareName}, signée par le hub.`}
      fullScreenMobile
    >
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        {prefill?.renewOf ? (
          <Banner level="info">
            L'ancienne clé reste valable jusqu'au {formatDay(prefill.renewOf)} inclus : la nouvelle s'ajoute, elle ne la remplace pas.
          </Banner>
        ) : null}

        <ErpClientField
          value={client}
          onChange={setClient}
          onPicked={(c) => {
            if (!entrepriseTouched || !entreprise.trim()) setEntreprise(c.displayName);
          }}
        />

        <Field
          label="Nom de l'entreprise"
          hint="Écrit dans la clé et imposé sur les documents de Tracebay. Vérifiez l'orthographe : il ne se modifie plus."
          error={entrepriseError ?? undefined}
        >
          <Input
            ref={entrepriseRef}
            value={entreprise}
            required
            maxLength={ENTREPRISE_MAX}
            autoComplete="organization"
            onChange={(e) => {
              setEntreprise(e.target.value);
              setEntrepriseTouched(true);
            }}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Durée" error={duration === DATE ? undefined : (durationError ?? undefined)}>
            <Select id={`${ids}-duration`} value={duration} onChange={(e) => setDuration(e.target.value)} className="cursor-pointer">
              {LICENSE_MONTHS.map((m) => (
                <option key={m} value={String(m)}>
                  {m} mois{m === DEFAULT_MONTHS ? " (par défaut)" : ""}
                </option>
              ))}
              <option value={DATE}>Jusqu'à une date précise</option>
            </Select>
          </Field>
          {duration === DATE ? (
            <Field label="Date de fin (incluse)" error={durationError ?? undefined}>
              <Input type="date" value={expireDate} min={today} max={addMonths(today, 120)} onChange={(e) => setExpireDate(e.target.value)} />
            </Field>
          ) : null}
        </div>

        <Field label="Contact (facultatif)" hint="Personne qui a demandé la clé. Chiffré sur le hub, jamais écrit dans la clé.">
          <Input value={contact} maxLength={200} autoComplete="off" onChange={(e) => setContact(e.target.value)} />
        </Field>

        <Field label="Notes (facultatif)">
          <Textarea value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <section aria-labelledby={`${ids}-preview`} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-subtle)] p-4">
          <h3 id={`${ids}-preview`} className="text-sm font-semibold text-[var(--text)]">
            Aperçu de la clé
          </h3>
          <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-[var(--muted)]">Entreprise</dt>
            <dd className="min-w-0 break-words font-medium text-[var(--text)]">{name.ok ? name.value : "À renseigner"}</dd>
            <dt className="text-[var(--muted)]">Émise le</dt>
            <dd className="text-[var(--text)]">{formatDay(today)}</dd>
            <dt className="text-[var(--muted)]">Valable jusqu'au</dt>
            <dd className="text-[var(--text)]">{expiry.ok ? `${formatDay(expiry.value)} inclus` : "À choisir"}</dd>
          </dl>
        </section>

        {serverError ? (
          <Banner level="error" role="alert">
            {serverError}
          </Banner>
        ) : null}

        <ModalActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Annuler
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Émission…" : "Émettre la clé"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
