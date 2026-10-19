import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCloudArrowUp } from "@fortawesome/free-solid-svg-icons";
import type { SiteDetail, VersionCheck } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/**
 * Barre « Modifications non publiées » : note de version et « Publier la version N ». Contrôle de la version en
 * défaut (projet non construit, index.html absent) : publication bloquée, « Publier quand même » après confirmation.
 */
export function PublishBar({
  site,
  check,
  checkId,
  nextVersion,
  onSite,
}: {
  site: SiteDetail;
  check: VersionCheck | null;
  /** Avertissement du contrôle, relié au bouton (aria-describedby). */
  checkId: string;
  nextVersion: number;
  onSite: (s: SiteDetail) => void;
}) {
  const noteId = useId();
  const whyId = useId();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmForce, setConfirmForce] = useState(false);
  const running = site.operation?.status === "RUNNING";
  const unavailable = running || site.state === "CREATING" || site.state === "DELETING";
  const blocked = !!check || unavailable;
  const why = running ? "Une opération est en cours. La publication sera possible à la fin." : null;

  async function publish(force: boolean) {
    setBusy(true);
    try {
      const updated = await api<SiteDetail>(`/api/sites/${site.id}/publish`, {
        method: "POST",
        json: { ...(note.trim() ? { note: note.trim() } : {}), ...(force ? { force: true } : {}) },
      });
      onSite(updated);
      setNote("");
      setConfirmForce(false);
      toast.success(`Publication de la version ${nextVersion} lancée`);
    } catch (err) {
      toast.error(errorMessage(err, "Publication impossible."));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!blocked) void publish(false);
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-labelledby={`${noteId}-title`}
      className="rounded-[var(--radius-lg)] border border-[var(--warning)]/40 bg-[var(--warning-soft)] p-4"
    >
      <h2 id={`${noteId}-title`} className="text-base font-semibold text-[var(--text)]">
        Modifications non publiées
      </h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Les fichiers de travail ont changé. {site.hostname} montre encore{" "}
        {site.currentVersion ? `la version ${site.currentVersion.number}` : "la page d'attente"}.
      </p>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 space-y-1.5">
          <label htmlFor={noteId} className="block text-sm font-medium text-[var(--text)]">
            Note de version (facultatif)
          </label>
          <Input
            id={noteId}
            value={note}
            maxLength={200}
            autoComplete="off"
            placeholder="Ce qui change"
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={blocked || busy} aria-describedby={check ? checkId : why ? whyId : undefined}>
          <FontAwesomeIcon icon={faCloudArrowUp} className="h-3.5 w-3.5" aria-hidden />
          {busy ? "Publication…" : `Publier la version ${nextVersion}`}
        </Button>
        {check && !unavailable ? (
          <Button type="button" variant="secondary" disabled={busy} onClick={() => setConfirmForce(true)}>
            Publier quand même…
          </Button>
        ) : null}
      </div>
      {check ? <p className="mt-2 text-sm text-[var(--warning)]">Publication bloquée par le contrôle de la version (ci-dessus).</p> : null}
      {why ? (
        <p id={whyId} className="mt-2 text-sm text-[var(--warning)]">
          {why}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirmForce}
        title={`Publier quand même la version ${nextVersion} ?`}
        message={
          <>
            <p>{check?.message}</p>
            <p className="mt-2">
              Ne continuez que pour un site statique dont l'accueil n'est volontairement pas à la racine. Sinon, {site.hostname} montrera des
              fichiers sources ou une page introuvable.
            </p>
          </>
        }
        confirmLabel="Publier quand même"
        busy={busy}
        onConfirm={() => void publish(true)}
        onClose={() => setConfirmForce(false)}
      />
    </form>
  );
}
