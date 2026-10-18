import type { RejectedFile } from "@hub/contract";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { formatBytes, formatDecimal, plural } from "@/lib/format";
import type { SendProgress } from "@/lib/uploadSession";

export type Progress = { label: string; state: SendProgress; cancel: () => void };

/** Progression d'un envoi : phase, octets et fichiers en texte, barre, « Annuler l'envoi ». */
export function UploadProgress({ progress }: { progress: Progress }) {
  const s = progress.state;
  const pct = s.bytesTotal ? Math.min(100, Math.round((100 * s.bytesDone) / s.bytesTotal)) : s.phase === "finish" ? 100 : 0;
  const text =
    s.phase === "hash"
      ? `Préparation de ${progress.label} : ${s.filesTotal > 1 ? `${formatDecimal(s.filesDone, 0)} fichiers sur ${formatDecimal(s.filesTotal, 0)}` : `${pct} %`}`
      : s.phase === "finish"
        ? `Vérification et enregistrement de ${progress.label}…`
        : `Envoi : ${formatBytes(s.bytesDone)} sur ${formatBytes(s.bytesTotal)} (${pct} %)${s.filesTotal > 1 ? `, ${s.filesDone > 1 ? `${formatDecimal(s.filesDone, 0)} fichiers` : `${s.filesDone} fichier`} sur ${formatDecimal(s.filesTotal, 0)}` : ""}`;
  return (
    <div className="space-y-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-subtle)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="min-w-0 text-[var(--text)]" aria-live="polite">
          {text}
        </span>
        {s.phase !== "finish" ? (
          <Button variant="ghost" onClick={progress.cancel}>
            Annuler l'envoi
          </Button>
        ) : null}
      </div>
      <div className="progress" role="progressbar" aria-label={`Envoi de ${progress.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export type SkippedItem = { path: string; reason: string; size?: number };

type Group = { reason: string; count: number; bytes: number; examples: string[] };

/** Écartés regroupés par raison (17 000 fichiers de node_modules : une ligne), fichiers trop lourds nommés un par un. */
function groupItems(items: SkippedItem[]): Group[] {
  const map = new Map<string, Group>();
  for (const it of items) {
    const key = it.reason.startsWith("Fichier de ") ? `${it.reason}|${it.path}` : it.reason;
    const g = map.get(key) ?? { reason: it.reason, count: 0, bytes: 0, examples: [] };
    g.count++;
    g.bytes += it.size ?? 0;
    if (g.examples.length < 3) g.examples.push(it.path);
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export function SkippedList({ items }: { items: SkippedItem[] }) {
  return (
    // Liste qui défile : atteignable au clavier pour la faire défiler.
    <ul tabIndex={0} aria-label="Fichiers écartés" className="mt-2 max-h-56 space-y-2 overflow-y-auto rounded-[var(--radius-sm)] pr-1">
      {groupItems(items).map((g) => (
        <li key={`${g.reason}${g.examples[0]}`} className="break-words">
          {g.count === 1 ? <span className="font-mono">{g.examples[0]}</span> : <span className="font-medium">{plural(g.count, "fichier", "fichiers")}</span>}
          {g.count > 1 && g.bytes ? <span className="text-[var(--muted)]"> ({formatBytes(g.bytes)})</span> : null}
          <span className="text-[var(--muted)]"> : {g.reason}</span>
          {g.count > 1 ? <span className="block font-mono text-xs text-[var(--muted)]">ex. {g.examples.join(", ")}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** Résumé après un envoi : reçus, puis écartés (avant l'envoi par l'interface et par le serveur) avec leurs raisons. */
export function RejectedSummary({
  accepted,
  rejected,
  onClose,
}: {
  accepted: number;
  rejected: Array<RejectedFile | SkippedItem>;
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
      <SkippedList items={rejected} />
    </Banner>
  );
}
