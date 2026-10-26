import { useEffect, useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronRight } from "@fortawesome/free-solid-svg-icons";
import type { SmtpSettings } from "@hub/contract";
import { api, errorMessage, type ApiError } from "@/lib/api";
import { smtpStatus } from "@/lib/settingsStatus";
import { useResource } from "@/lib/useResource";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { Tile } from "@/components/ui/Tile";

type Values = { host: string; port: string; security: "ssl" | "starttls"; user: string; password: string; from: string; to: string };
type Key = keyof Values;

const toValues = (s: SmtpSettings): Values => ({
  host: s.host ?? "",
  port: s.port ? String(s.port) : "",
  security: s.security,
  user: s.user ?? "",
  password: "",
  from: s.from ?? "",
  to: s.to ?? "",
});

/**
 * Tuile « Envoi d'e-mails » (lot P5) : compte SMTP du hub, pour remettre à Alexandre les e-mails capturés des sites
 * PHP. Le mot de passe n'est jamais relu : champ vide = inchangé.
 */
export function SmtpTile() {
  const settings = useResource<SmtpSettings>("/api/settings/smtp");
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Values | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const missingId = useId();
  const saved = settings.data;

  useEffect(() => {
    if (saved) setValues(toValues(saved));
  }, [saved]);

  const set = (key: Key, value: string) => {
    setValues((v) => (v ? { ...v, [key]: value } : v));
    if (errors[key]) setErrors((x) => ({ ...x, [key]: undefined }));
  };

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!values) return;
    const port = values.port.trim() ? Number(values.port) : null;
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      setErrors({ port: "Port de 1 à 65535 (587 en STARTTLS, 465 en SSL)." });
      return;
    }
    setBusy(true);
    try {
      const next = await api<SmtpSettings>("/api/settings/smtp", {
        method: "PATCH",
        json: { host: values.host, port, security: values.security, user: values.user, from: values.from, to: values.to, ...(values.password ? { password: values.password } : {}) },
      });
      settings.setData(next);
      toast.success("Compte SMTP enregistré");
      setErrors({});
    } catch (err) {
      const field = (err as ApiError).field as Key | undefined;
      if (field) setErrors({ [field]: errorMessage(err) });
      else toast.error(errorMessage(err, "Enregistrement impossible."));
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    try {
      const r = await api<{ sentTo: string }>("/api/settings/smtp/essai", { method: "POST" });
      toast.success(`E-mail d'essai envoyé à ${r.sentTo}`);
    } catch (err) {
      toast.error(errorMessage(err, "Envoi impossible."));
    } finally {
      setTesting(false);
    }
  }

  return (
    <Tile id="smtp" className="scroll-mt-4" title="Envoi d'e-mails" level={2} status={smtpStatus({ data: saved, error: settings.error })}>
      {settings.loading && !saved ? (
        <p role="status" className="text-sm text-[var(--muted)]">
          Lecture…
        </p>
      ) : settings.error && !saved ? (
        <Button variant="ghost" className="self-start" onClick={() => void settings.reload()}>
          Réessayer
        </Button>
      ) : saved && values ? (
        <>
          <p className="text-sm text-[var(--muted)]">Remet à votre adresse les e-mails capturés des sites PHP. Les sites, eux, n'envoient jamais rien.</p>
          {saved.configured ? (
            <dl className="space-y-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <dt className="text-xs text-[var(--muted)]">Serveur</dt>
                <dd className="min-w-0 break-all text-sm">
                  {saved.host}:{saved.port ?? 587} ({saved.security === "ssl" ? "SSL" : "STARTTLS"})
                </dd>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <dt className="text-xs text-[var(--muted)]">Reçus à</dt>
                <dd className="min-w-0 break-all text-sm">{saved.to}</dd>
              </div>
            </dl>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void sendTest()} disabled={testing || !saved.configured} aria-describedby={saved.configured ? undefined : missingId}>
              {testing ? "Envoi… (45 s au plus)" : "Envoyer un e-mail d'essai"}
            </Button>
          </div>
          {saved.configured ? null : (
            <p id={missingId} className="text-sm text-[var(--warning)]">
              Essai indisponible : il manque {[!saved.host && "le serveur SMTP", !saved.from && "l'adresse d'expédition", !saved.to && "« Mon adresse (réception) »"].filter(Boolean).join(", ")}.
            </p>
          )}
          <details className="code-details" open={open || !saved.configured} onToggle={(e) => setOpen(e.currentTarget.open)}>
            <summary className="code-summary">
              <FontAwesomeIcon icon={faChevronRight} className="code-chevron h-3 w-3 shrink-0 text-[var(--muted)]" aria-hidden />
              Régler le compte SMTP
            </summary>
            <form onSubmit={onSubmit} className="space-y-4 pb-1" noValidate>
              <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <Field label="Serveur SMTP" hint="Exemple : smtp.hostinger.com" error={errors.host}>
                  <Input value={values.host} onChange={(e) => set("host", e.target.value)} autoComplete="off" spellCheck={false} maxLength={253} />
                </Field>
                <Field label="Port" error={errors.port}>
                  <Input value={values.port} onChange={(e) => set("port", e.target.value)} inputMode="numeric" autoComplete="off" placeholder="587" maxLength={5} />
                </Field>
              </div>
              <Field label="Chiffrement">
                <Select value={values.security} onChange={(e) => set("security", e.target.value)}>
                  <option value="starttls">STARTTLS (port 587)</option>
                  <option value="ssl">SSL (port 465)</option>
                </Select>
              </Field>
              <Field label="Identifiant" error={errors.user}>
                <Input value={values.user} onChange={(e) => set("user", e.target.value)} autoComplete="username" spellCheck={false} maxLength={254} />
              </Field>
              <Field label="Mot de passe" hint={saved.passwordSet ? "Enregistré, jamais affiché. Laisser vide pour le garder." : "Chiffré dans le hub, jamais affiché."}>
                <Input type="password" value={values.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" maxLength={1024} />
              </Field>
              <Field label="Adresse d'expédition" hint="Une adresse du compte SMTP (sinon refusée par les boîtes de réception)." error={errors.from}>
                <Input type="email" inputMode="email" value={values.from} onChange={(e) => set("from", e.target.value)} autoComplete="email" maxLength={254} />
              </Field>
              <Field label="Mon adresse (réception)" hint="Destination du bouton « Envoyer à mon adresse »." error={errors.to}>
                <Input type="email" inputMode="email" value={values.to} onChange={(e) => set("to", e.target.value)} autoComplete="email" maxLength={254} />
              </Field>
              <Button type="submit" disabled={busy}>
                {busy ? "Enregistrement…" : "Enregistrer"}
              </Button>
            </form>
          </details>
        </>
      ) : null}
    </Tile>
  );
}
