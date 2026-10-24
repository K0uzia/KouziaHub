import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faFileZipper } from "@fortawesome/free-solid-svg-icons";
import type { UploadResult, UploadSession } from "@hub/contract";
import { errorMessage, isAbort } from "@/lib/api";
import { cancelSession, openSessions, sendZip } from "@/lib/uploadSession";
import { formatBytes, plural } from "@/lib/format";
import { finePointer } from "@/lib/files";
import { useDropTarget } from "@/lib/useDropTarget";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Banner } from "@/components/ui/Banner";
import { hasNotices, RejectedSummary, UploadProgress, type Progress } from "@/components/sites/UploadFeedback";

type Mode = "replace" | "merge";
const MODES = [
  { id: "replace", label: "Remplacer tout le contenu" },
  { id: "merge", label: "Ajouter et remplacer les doublons" },
] as const;

const MODE_HINT: Record<Mode, string> = {
  replace: "Conseillé pour un site complet : les fichiers de travail actuels sont retirés, le contenu du zip devient le site (le .htaccess généré par le hub est gardé).",
  merge: "Le contenu du zip s'ajoute aux fichiers de travail ; un fichier en double est remplacé, rien n'est retiré.",
};

function isZip(file: File) {
  return /\.zip$/i.test(file.name) || file.type === "application/zip" || file.type === "application/x-zip-compressed";
}

/** Envoi du site entier en zip (voie principale, téléphone compris), en remplacement ou en fusion. */
export function ZipUpload({
  siteId,
  publicDir = null,
  fileCount,
  maxZipBytes,
  busy,
  onDone,
}: {
  siteId: string;
  /** Site PHP : son dossier public (vide : racine du projet) ; null pour un site statique. */
  publicDir?: string | null;
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
  const [interrupted, setInterrupted] = useState<UploadSession[]>([]);
  const [resume, setResume] = useState<UploadSession | null>(null);
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
    // Remplacer tout efface les fichiers de travail actuels : confirmation s'il y en a (sauf reprise, déjà confirmée).
    if (!resume && mode === "replace" && fileCount > 0) setPending(file);
    else void send(file);
  }

  async function send(file: File) {
    setPending(null);
    setResult(null);
    const ctrl = new AbortController();
    let opened: UploadSession | null = null;
    let cancelled = false;
    const resuming = resume;
    setProgress({
      label: `« ${file.name} »`,
      state: { phase: "hash", bytesDone: 0, bytesTotal: file.size, filesDone: 0, filesTotal: 1 },
      cancel: () => {
        cancelled = true;
        ctrl.abort();
      },
    });
    try {
      // Envoi par morceaux de 8 Mio : pas de plafond de 100 Mo par requête, reprise possible après une coupure.
      const res = await sendZip({
        siteId,
        file,
        mode: resuming?.mode ?? mode,
        resume: resuming,
        signal: ctrl.signal,
        onSession: (sess) => (opened = sess),
        onProgress: (state) => setProgress((p) => (p ? { ...p, state } : p)),
      });
      setResume(null);
      setInterrupted([]);
      onDone(res);
      toast.success(`${plural(res.accepted.length, "fichier reçu", "fichiers reçus")} depuis le zip${res.removed ? `, ${plural(res.removed, "ancien fichier retiré", "anciens fichiers retirés")}` : ""}`);
      if (res.rejected.length || res.strippedRoot || hasNotices(res)) setResult(res);
      if (res.rejected.length) toast.warning(plural(res.rejected.length, "fichier écarté", "fichiers écartés"));
    } catch (err) {
      const session = opened as UploadSession | null;
      if (isAbort(err) && cancelled) {
        if (session) await cancelSession(siteId, session.id).catch(() => undefined);
        setResume(null);
        toast.info("Envoi annulé");
      } else {
        const message = errorMessage(err, "Envoi du zip impossible.");
        setError(message);
        toast.error(message);
        if (session) setInterrupted([session]);
      }
      void refreshInterrupted();
    } finally {
      setProgress(null);
    }
  }

  async function refreshInterrupted() {
    try {
      setInterrupted((await openSessions(siteId)).filter((x) => x.kind === "zip"));
    } catch {
      /* facultatif */
    }
  }

  useEffect(() => {
    void refreshInterrupted();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

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
          {publicDir === null
            ? "Un zip du dossier du site, avec index.html à la racine du zip ou dans un seul dossier."
            : `Un zip du projet PHP (son code et ${publicDir ? `le dossier ${publicDir}/ avec index.php` : "index.php à la racine"}), à la racine du zip ou dans un seul dossier.`}
          {maxZipBytes ? ` ${formatBytes(maxZipBytes)} au plus.` : ""}
        </p>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Segmented options={MODES} value={mode} onChange={setMode} label="Mode d'envoi du zip" stack className="w-full sm:w-auto" />
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
          {!progress && interrupted.length ? (
            <Banner
              level="warning"
              action={
                <Button
                  variant="ghost"
                  onClick={() =>
                    void cancelSession(siteId, interrupted[0]!.id)
                      .catch(() => undefined)
                      .then(() => {
                        setResume(null);
                        toast.info("Envoi interrompu annulé");
                        return refreshInterrupted();
                      })
                  }
                >
                  Annuler cet envoi
                </Button>
              }
            >
              <p className="font-medium">
                L'envoi de « {interrupted[0]!.files[0]?.path} » n'a pas abouti : {interrupted[0]!.received.length} morceau(x) reçu(s) sur{" "}
                {interrupted[0]!.chunkCount}.
              </p>
              {resume?.id === interrupted[0]!.id ? (
                <p className="mt-1">Choisissez maintenant le même zip : seuls les morceaux manquants partiront.</p>
              ) : (
                <div className="mt-2">
                  <Button variant="secondary" onClick={() => setResume(interrupted[0]!)}>
                    Reprendre cet envoi
                  </Button>
                </div>
              )}
            </Banner>
          ) : null}
          {result?.strippedRoot ? (
            <Banner level="info" role="status">
              Le zip contenait un seul dossier, <span className="font-mono">{result.strippedRoot}</span> : son contenu a été placé à la racine du site.
            </Banner>
          ) : null}
          {result && (result.rejected.length || hasNotices(result)) ? (
            <RejectedSummary accepted={result.accepted.length} rejected={result.rejected} notices={result} onClose={() => setResult(null)} />
          ) : null}
        </div>
      </section>

      <ConfirmDialog
        open={pending !== null}
        title="Remplacer tout le contenu du site ?"
        message={
          <>
            <p>
              Les {plural(fileCount, "fichier de travail actuel", "fichiers de travail actuels")} seront retirés et remplacés par le contenu de{" "}
              <strong className="break-all">« {pending?.name} »</strong>.
            </p>
            <p className="mt-2 text-[var(--muted)]">Les versions déjà publiées ne changent pas. Le site en ligne ne change qu'à la prochaine publication.</p>
          </>
        }
        confirmLabel="Remplacer tout le contenu"
        danger
        onConfirm={() => pending && void send(pending)}
        onClose={() => setPending(null)}
      />
    </Card>
  );
}
