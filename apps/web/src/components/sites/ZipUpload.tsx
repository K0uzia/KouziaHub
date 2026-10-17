import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faFileZipper } from "@fortawesome/free-solid-svg-icons";
import type { UploadResult } from "@hub/contract";
import { errorMessage, isAbort, upload } from "@/lib/api";
import { formatBytes, plural } from "@/lib/format";
import { finePointer } from "@/lib/files";
import { useDropTarget } from "@/lib/useDropTarget";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { RejectedSummary, UploadProgress, type Progress } from "@/components/sites/UploadFeedback";

type Mode = "replace" | "merge";
const MODES = [
  { id: "replace", label: "Remplacer tout" },
  { id: "merge", label: "Fusionner" },
] as const;

const MODE_HINT: Record<Mode, string> = {
  replace: "Les fichiers de travail actuels sont retirés, le contenu du zip les remplace.",
  merge: "Le contenu du zip s'ajoute aux fichiers de travail ; un fichier du même nom est remplacé.",
};

function isZip(file: File) {
  return /\.zip$/i.test(file.name) || file.type === "application/zip" || file.type === "application/x-zip-compressed";
}

/** Envoi du site entier en zip (voie principale, téléphone compris), en remplacement ou en fusion. */
export function ZipUpload({
  siteId,
  fileCount,
  maxZipBytes,
  busy,
  onDone,
}: {
  siteId: string;
  fileCount: number;
  maxZipBytes: number | null;
  /** Un autre envoi est en cours dans l'explorateur. */
  busy: boolean;
  onDone: (res: UploadResult) => void;
}) {
  const ids = useId();
  const input = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>("replace");
  const [pending, setPending] = useState<File | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [desktop] = useState(finePointer);

  function choose(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!isZip(file)) {
      setError(`« ${file.name} » n'est pas un fichier zip.`);
      return;
    }
    if (file.size === 0) {
      setError(`« ${file.name} » est vide.`);
      return;
    }
    if (maxZipBytes && file.size > maxZipBytes) {
      setError(`« ${file.name} » pèse ${formatBytes(file.size)} : le maximum est ${formatBytes(maxZipBytes)}.`);
      return;
    }
    // Remplacer tout efface les fichiers de travail actuels : confirmation s'il y en a.
    if (mode === "replace" && fileCount > 0) setPending(file);
    else void send(file);
  }

  async function send(file: File) {
    setPending(null);
    setResult(null);
    const form = new FormData();
    form.append("mode", mode);
    form.append("file", file, file.name);
    const ctrl = new AbortController();
    setProgress({ fraction: 0, label: `« ${file.name} »`, cancel: () => ctrl.abort() });
    try {
      const res = await upload<UploadResult>(`/api/sites/${siteId}/zip`, form, {
        signal: ctrl.signal,
        onProgress: (fraction) => setProgress((p) => (p ? { ...p, fraction } : p)),
      });
      onDone(res);
      toast.success(`${plural(res.accepted.length, "fichier reçu", "fichiers reçus")} depuis le zip`);
      if (res.rejected.length) {
        setResult(res);
        toast.warning(plural(res.rejected.length, "fichier écarté", "fichiers écartés"));
      }
    } catch (err) {
      if (isAbort(err)) toast.info("Envoi annulé");
      else {
        const message = errorMessage(err, "Envoi du zip impossible.");
        setError(message);
        toast.error(message);
      }
    } finally {
      setProgress(null);
    }
  }

  const drop = useDropTarget((dt) => {
    const files = Array.from(dt.files);
    if (files.length !== 1) {
      setError("Déposez un seul fichier zip.");
      return;
    }
    choose(files[0]);
  }, desktop && !progress && !busy);

  return (
    <Card className="p-0">
      <section
        aria-labelledby={`${ids}-title`}
        {...drop.handlers}
        data-over={drop.over}
        className="dropzone dropzone-quiet p-4 sm:p-5"
      >
        <h2 id={`${ids}-title`} className="text-base font-semibold">
          Envoyer le site entier (zip)
        </h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Un zip du dossier du site, avec index.html à la racine du zip ou dans un seul dossier.
          {maxZipBytes ? ` ${formatBytes(maxZipBytes)} au plus.` : ""}
        </p>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Segmented options={MODES} value={mode} onChange={setMode} label="Mode d'envoi du zip" className="w-full sm:w-auto" />
            <p className="text-sm text-[var(--muted)]">{MODE_HINT[mode]}</p>
          </div>
          <Button onClick={() => input.current?.click()} disabled={!!progress || busy} aria-describedby={error ? `${ids}-error` : undefined}>
            <FontAwesomeIcon icon={faFileZipper} className="h-3.5 w-3.5" aria-hidden />
            Choisir un zip
          </Button>
          <input
            ref={input}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(e) => {
              choose(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>

        {desktop ? (
          <p className="mt-3 text-xs text-[var(--muted)]">{drop.over ? "Déposez le zip pour l'envoyer." : "Vous pouvez aussi glisser le zip sur ce cadre."}</p>
        ) : null}

        <div className="mt-3 space-y-3 empty:hidden">
          {error ? (
            <p id={`${ids}-error`} role="alert" className="text-sm text-[var(--danger)]">
              {error}
            </p>
          ) : null}
          {progress ? <UploadProgress progress={progress} /> : null}
          {result ? <RejectedSummary accepted={result.accepted.length} rejected={result.rejected} onClose={() => setResult(null)} /> : null}
        </div>
      </section>

      <ConfirmDialog
        open={pending !== null}
        title="Remplacer tous les fichiers de travail ?"
        message={
          <>
            <p>
              Les {plural(fileCount, "fichier de travail actuel", "fichiers de travail actuels")} seront retirés et remplacés par le contenu de{" "}
              <strong className="break-all">« {pending?.name} »</strong>.
            </p>
            <p className="mt-2 text-[var(--muted)]">Les versions déjà publiées ne changent pas. Le site en ligne ne change qu'à la prochaine publication.</p>
          </>
        }
        confirmLabel="Remplacer tout"
        danger
        onConfirm={() => pending && void send(pending)}
        onClose={() => setPending(null)}
      />
    </Card>
  );
}
