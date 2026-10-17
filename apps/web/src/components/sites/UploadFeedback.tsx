import type { RejectedFile } from "@hub/contract";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { plural } from "@/lib/format";

export type Progress = { fraction: number; label: string; cancel: () => void };

/** Progression d'un envoi : barre, pourcentage en texte, bouton « Annuler ». */
export function UploadProgress({ progress }: { progress: Progress }) {
  const pct = Math.round(progress.fraction * 100);
  return (
    <div className="space-y-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-subtle)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-[var(--text)]">
          {pct >= 100 ? `Traitement de ${progress.label}…` : `Envoi de ${progress.label} : ${pct} %`}
        </span>
        {pct < 100 ? (
          <Button variant="ghost" onClick={progress.cancel}>
            Annuler l'envoi
          </Button>
        ) : null}
      </div>
      <div
        className="progress"
        role="progressbar"
        aria-label={`Envoi de ${progress.label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Résumé des fichiers écartés par le serveur, avec leurs raisons ; reste affiché jusqu'à « Fermer ». */
export function RejectedSummary({
  accepted,
  rejected,
  onClose,
}: {
  accepted: number;
  rejected: RejectedFile[];
  onClose: () => void;
}) {
  return (
    <Banner
      level="warning"
      role="status"
      action={
        <Button variant="ghost" onClick={onClose}>
          Fermer
        </Button>
      }
    >
      <p className="font-medium">
        {plural(accepted, "fichier reçu", "fichiers reçus")}, {plural(rejected.length, "fichier écarté", "fichiers écartés")} :
      </p>
      <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto pr-1">
        {rejected.map((r) => (
          <li key={r.path} className="break-words">
            <span className="font-mono">{r.path}</span>
            <span className="text-[var(--muted)]"> : {r.reason}</span>
          </li>
        ))}
      </ul>
    </Banner>
  );
}
