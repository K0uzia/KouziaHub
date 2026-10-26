import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faDownload, faEnvelope, faPaperclip, faTrashCan } from "@fortawesome/free-solid-svg-icons";
import type { PhpMailDetail, PhpMailList, PhpMailRedirect, SiteDetail } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";
import { useResource } from "@/lib/useResource";
import { Banner } from "@/components/ui/Banner";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field, Textarea } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";

// Onglet « E-mails » d'un site PHP (docs/cadrage.md, 11.6, lot P5) : e-mails capturés (jamais envoyés au
// destinataire d'origine), lecture isolée, remise à une adresse autorisée, option de redirection.

export function PhpMailsTab({ site }: { site: SiteDetail }) {
  const list = useResource<PhpMailList>(`/api/sites/${site.id}/php/mails`);
  const [selected, setSelected] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [busy, setBusy] = useState(false);
  const mails = list.data?.mails ?? [];
  const current = selected && mails.some((m) => m.id === selected) ? selected : null;

  async function clearAll() {
    setBusy(true);
    try {
      const r = await api<{ removed: number }>(`/api/sites/${site.id}/php/mails`, { method: "DELETE" });
      toast.success(`${r.removed} e-mail(s) retiré(s)`);
      setSelected(null);
      setClearing(false);
      void list.reload();
    } catch (err) {
      toast.error(errorMessage(err, "Suppression impossible."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {list.data ? <RedirectCard site={site} list={list.data} onSaved={() => void list.reload()} /> : null}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card className="min-w-0 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">E-mails capturés</h2>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => void list.reload()} disabled={list.loading}>
                Actualiser
              </Button>
              <Button variant="ghost" onClick={() => setClearing(true)} disabled={!mails.length}>
                <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" aria-hidden />
                Tout supprimer
              </Button>
            </div>
          </div>
          <p className="mt-1 text-sm text-[var(--muted)]">Ce que le site envoie est gardé ici (100 derniers), jamais remis au destinataire d'origine.</p>
          {list.error ? (
            <Banner level="error" className="mt-3">
              {list.error}
            </Banner>
          ) : null}
          {list.data && !mails.length ? <p className="mt-4 text-sm text-[var(--muted)]">Aucun e-mail capturé pour l'instant.</p> : null}
          {mails.length ? (
            <ul className="mt-3 divide-y divide-[var(--border)]" aria-label="E-mails capturés">
              {mails.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(m.id)}
                    aria-current={current === m.id ? "true" : undefined}
                    className="flex min-h-11 w-full flex-col gap-0.5 rounded-[var(--radius-sm)] px-2 py-2 text-left hover:bg-[var(--surface-2)] aria-[current=true]:bg-[var(--surface-2)]"
                  >
                    <span className="flex w-full items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate font-medium">{m.subject ?? "(sans objet)"}</span>
                      <span className="shrink-0 text-xs text-[var(--muted)]">{formatDateTime(m.receivedAt)}</span>
                    </span>
                    <span className="w-full truncate text-xs text-[var(--muted)]">
                      Pour {m.to.join(", ") || "destinataire inconnu"}
                      {m.from ? `, de ${m.from}` : ""}
                    </span>
                    {m.attachments ? (
                      <span className="text-xs text-[var(--muted)]">
                        <FontAwesomeIcon icon={faPaperclip} className="mr-1 h-3 w-3" aria-hidden />
                        {m.attachments} pièce(s) jointe(s)
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
        {current && list.data ? (
          <MailViewer
            key={current}
            site={site}
            id={current}
            smtp={list.data.smtp}
            onRemoved={() => {
              setSelected(null);
              void list.reload();
            }}
          />
        ) : mails.length ? (
          <Card className="p-4 sm:p-5">
            <p className="text-sm text-[var(--muted)]">Choisir un e-mail pour le lire.</p>
          </Card>
        ) : null}
      </div>
      <ConfirmDialog
        open={clearing}
        title="Supprimer les e-mails capturés"
        message={`Les ${mails.length} e-mail(s) capturé(s) de ce site seront retirés du serveur.`}
        confirmLabel="Tout supprimer"
        danger
        busy={busy}
        onConfirm={() => void clearAll()}
        onClose={() => setClearing(false)}
      />
    </div>
  );
}

function RedirectCard({ site, list, onSaved }: { site: SiteDetail; list: PhpMailList; onSaved: () => void }) {
  const [text, setText] = useState(list.redirect.recipients.join("\n"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();
  const errorId = useId();
  useEffect(() => setText(list.redirect.recipients.join("\n")), [list.redirect.recipients]);

  async function save(change: Partial<{ enabled: boolean; recipients: string[] }>) {
    setSaving(true);
    setError(null);
    try {
      const r = await api<PhpMailRedirect>(`/api/sites/${site.id}/php/mails/redirection`, { method: "PATCH", json: change });
      toast.success(change.enabled === undefined ? "Adresses autorisées enregistrées" : r.enabled ? "Redirection activée" : "Redirection coupée");
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Enregistrement impossible."));
    } finally {
      setSaving(false);
    }
  }

  const recipients = text.split(/[\s,;]+/).filter(Boolean);
  const target = list.redirect.recipients.length ? list.redirect.recipients.join(", ") : (list.smtp.to ?? "mon adresse");
  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-base font-semibold">Rediriger les e-mails vers mon adresse</h2>
      <p id={hintId} className="mt-1 text-sm text-[var(--muted)]">
        Chaque nouvel e-mail capturé est aussi remis, par le SMTP du hub, aux seules adresses autorisées (sinon à {list.smtp.to ?? "l'adresse de réception des réglages"}). Le destinataire d'origine est dans l'objet, jamais
        destinataire. 30 par heure au plus.
      </p>
      {!list.smtp.configured ? (
        <Banner level="warning" className="mt-3">
          SMTP du hub non réglé : rien n'est envoyé.{" "}
          <Link to="/reglages#smtp" className="link link-inline">
            Régler l'envoi d'e-mails
          </Link>
        </Banner>
      ) : null}
      <div className="mt-3 max-w-md">
        <Switch
          checked={list.redirect.enabled}
          onChange={(next) => void save({ enabled: next })}
          label="Redirection"
          stateLabels={{ on: `Active, vers ${target}`, off: "Coupée" }}
          disabled={saving}
          describedBy={hintId}
        />
      </div>
      <form
        className="mt-4 space-y-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save({ recipients });
        }}
      >
        <Field label="Adresses autorisées (une par ligne, 10 au plus)" hint="Vide : l'adresse de réception des réglages.">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="font-mono"
          />
        </Field>
        {error ? (
          <Banner level="error" role="alert" id={errorId}>
            {error}
          </Banner>
        ) : null}
        <div className="flex justify-end">
          <Button type="submit" variant="secondary" disabled={saving || recipients.join("\n") === list.redirect.recipients.join("\n")}>
            Enregistrer les adresses
          </Button>
        </div>
      </form>
    </Card>
  );
}

type View = "html" | "texte" | "entetes";
type Width = "telephone" | "ordinateur";

function MailViewer({ site, id, smtp, onRemoved }: { site: SiteDetail; id: string; smtp: PhpMailList["smtp"]; onRemoved: () => void }) {
  const mail = useResource<PhpMailDetail>(`/api/sites/${site.id}/php/mails/${id}`);
  const [view, setView] = useState<View>("html");
  const [width, setWidth] = useState<Width>("ordinateur");
  const [remote, setRemote] = useState(false);
  const [sending, setSending] = useState(false);
  const [removing, setRemoving] = useState(false);
  const smtpHint = useId();
  const base = `/api/sites/${site.id}/php/mails/${id}`;
  const d = mail.data;
  const shown: View = d && !d.hasHtml && view === "html" ? "texte" : view;

  async function send() {
    setSending(true);
    try {
      const r = await api<{ sentTo: string[] }>(`${base}/envoyer`, { method: "POST" });
      toast.success(`Envoyé à ${r.sentTo.join(", ")}`);
    } catch (err) {
      toast.error(errorMessage(err, "Envoi impossible."));
    } finally {
      setSending(false);
    }
  }

  async function remove() {
    setRemoving(true);
    try {
      await api(base, { method: "DELETE" });
      toast.success("E-mail supprimé");
      onRemoved();
    } catch (err) {
      toast.error(errorMessage(err, "Suppression impossible."));
      setRemoving(false);
    }
  }

  return (
    <Card className="min-w-0 p-4 sm:p-5">
      {mail.error ? <Banner level="error">{mail.error}</Banner> : null}
      {!d && !mail.error ? <p className="text-sm text-[var(--muted)]">Lecture…</p> : null}
      {d ? (
        <div className="space-y-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold [overflow-wrap:anywhere]">{d.subject ?? "(sans objet)"}</h2>
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              <dt className="text-[var(--muted)]">De</dt>
              <dd className="[overflow-wrap:anywhere]">{d.from ?? "inconnu"}</dd>
              <dt className="text-[var(--muted)]">Pour</dt>
              <dd className="[overflow-wrap:anywhere]">{d.to.join(", ") || "inconnu"}</dd>
              {d.cc.length ? (
                <>
                  <dt className="text-[var(--muted)]">Copie</dt>
                  <dd className="[overflow-wrap:anywhere]">{d.cc.join(", ")}</dd>
                </>
              ) : null}
              <dt className="text-[var(--muted)]">Reçu</dt>
              <dd>
                {formatDateTime(d.receivedAt)}, {formatBytes(d.size)}
              </dd>
            </dl>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void send()} disabled={sending || !smtp.configured} aria-describedby={smtp.configured ? undefined : smtpHint}>
              <FontAwesomeIcon icon={faEnvelope} className="h-3.5 w-3.5" aria-hidden />
              {sending ? "Envoi…" : "Envoyer à mon adresse"}
            </Button>
            <a href={`${base}/eml`} className={buttonClass("secondary")} download>
              <FontAwesomeIcon icon={faDownload} className="h-3.5 w-3.5" aria-hidden />
              Télécharger (.eml)
            </a>
            <Button variant="ghost" onClick={() => void remove()} disabled={removing}>
              <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" aria-hidden />
              Supprimer
            </Button>
          </div>
          {!smtp.configured ? (
            <p id={smtpHint} className="text-xs text-[var(--muted)]">
              Envoi indisponible : SMTP du hub non réglé (Réglages, Envoi d'e-mails).
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Segmented<View>
              label="Affichage"
              value={shown}
              onChange={setView}
              options={[
                ...(d.hasHtml ? [{ id: "html" as const, label: "HTML" }] : []),
                { id: "texte", label: "Texte" },
                { id: "entetes", label: "En-têtes" },
              ]}
            />
            {shown === "html" ? (
              <Segmented<Width>
                label="Largeur"
                value={width}
                onChange={setWidth}
                options={[
                  { id: "telephone", label: "Téléphone" },
                  { id: "ordinateur", label: "Ordinateur" },
                ]}
              />
            ) : null}
          </div>
          {shown === "html" ? (
            <>
              {d.remoteContent && !remote ? (
                <Banner level="info">
                  Images et styles distants bloqués (ils signaleraient la lecture à leur serveur).{" "}
                  <button type="button" className="link link-inline" onClick={() => setRemote(true)}>
                    Les afficher
                  </button>
                </Banner>
              ) : null}
              <div className="overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-2">
                {/* Cadre isolé : ni scripts ni même origine ; la réponse a sa propre CSP (rien de distant sans clic). */}
                <iframe
                  key={remote ? "distant" : "local"}
                  title={`Rendu HTML : ${d.subject ?? "e-mail capturé"}`}
                  src={`${base}/html${remote ? "?distant=1" : ""}`}
                  sandbox="allow-popups allow-popups-to-escape-sandbox"
                  referrerPolicy="no-referrer"
                  className="mx-auto block h-[70vh] max-w-full rounded-[var(--radius-sm)] bg-white"
                  style={{ width: width === "telephone" ? "23.4375rem" : "100%" }}
                />
              </div>
            </>
          ) : shown === "texte" ? (
            <pre tabIndex={0} aria-label="Version texte" className="code-block max-h-[70vh] whitespace-pre-wrap">
              {d.text ?? "(pas de version texte)"}
            </pre>
          ) : (
            <pre tabIndex={0} aria-label="En-têtes complets" className="code-block max-h-[70vh] whitespace-pre-wrap [overflow-wrap:anywhere]">
              {d.headers.map((h) => `${h.name}: ${h.value}`).join("\n")}
            </pre>
          )}
          {d.attachmentsList.length ? (
            <div>
              <h3 className="text-sm font-semibold">Pièces jointes</h3>
              <ul className="mt-2 space-y-1 text-sm">
                {d.attachmentsList.map((a) => (
                  <li key={a.index}>
                    <a href={`${base}/pieces/${a.index}`} className="link link-inline [overflow-wrap:anywhere]" download={a.filename}>
                      {a.filename}
                    </a>{" "}
                    <span className="text-[var(--muted)]">
                      ({a.mimeType}, {formatBytes(a.size)}
                      {a.inline ? ", intégrée au message" : ""})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
