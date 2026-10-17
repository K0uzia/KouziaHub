import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCloudArrowUp } from "@fortawesome/free-solid-svg-icons";
import type { SiteDetail } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";

/** Barre « Modifications non publiées » : note de version et « Publier la version N ». */
export function PublishBar({
  site,
  hasIndex,
  nextVersion,
  onSite,
}: {
  site: SiteDetail;
  hasIndex: boolean;
  nextVersion: number;
  onSite: (s: SiteDetail) => void;
}) {
  const noteId = useId();
  const whyId = useId();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const running = site.operation?.status === "RUNNING";
  const blocked = !hasIndex || running || site.state === "CREATING" || site.state === "DELETING";
  const why = !hasIndex
    ? "Ajoutez un fichier index.html à la racine : c'est la page d'accueil du site."
    : running
      ? "Une opération est en cours. La publication sera possible à la fin."
      : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (blocked) return;
    setBusy(true);
    try {
      const updated = await api<SiteDetail>(`/api/sites/${site.id}/publish`, {
        method: "POST",
        json: note.trim() ? { note: note.trim() } : {},
      });
      onSite(updated);
      setNote("");
      toast.success(`Publication de la version ${nextVersion} lancée`);
    } catch (err) {
      toast.error(errorMessage(err, "Publication impossible."));
    } finally {
      setBusy(false);
    }
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
        <Button type="submit" disabled={blocked || busy} aria-describedby={why ? whyId : undefined}>
          <FontAwesomeIcon icon={faCloudArrowUp} className="h-3.5 w-3.5" aria-hidden />
          {busy ? "Publication…" : `Publier la version ${nextVersion}`}
        </Button>
      </div>
      {why ? (
        <p id={whyId} className="mt-2 text-sm text-[var(--warning)]">
          {why}
        </p>
      ) : null}
    </form>
  );
}
