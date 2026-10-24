import { Link } from "react-router-dom";
import type { BrokenReference, RejectedFile, ServerAppNotice } from "@hub/contract";
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

/** Alertes d'un envoi, montrées en tête : références vers des fichiers refusés, code serveur. */
export type UploadNoticesData = { brokenRefs?: BrokenReference[]; serverApp?: ServerAppNotice | null };

export const hasNotices = (n: UploadNoticesData | null | undefined) => Boolean(n && ((n.brokenRefs?.length ?? 0) > 0 || n.serverApp));

const SHOWN_TARGETS = 5;

/** Pages qui utilisent un fichier refusé, regroupées par fichier : « index.html et 2 autres pages utilisent … ». */
function BrokenRefs({ refs }: { refs: BrokenReference[] }) {
  const byTarget = new Map<string, { from: string[]; exceptable: boolean }>();
  for (const r of refs) {
    const t = byTarget.get(r.target) ?? { from: [], exceptable: r.exceptable };
    t.from.push(r.from);
    byTarget.set(r.target, t);
  }
  const targets = [...byTarget.entries()];
  const exceptable = targets.some(([, t]) => t.exceptable);
  const never = targets.some(([, t]) => !t.exceptable);
  return (
    <Banner
      level="error"
      role="alert"
      action={
        exceptable ? (
          <Link to="?tab=serveur" className="link inline-flex min-h-11 items-center text-sm font-medium">
            Ouvrir l'onglet Serveur
          </Link>
        ) : undefined
      }
    >
      <div className="min-w-0 space-y-2">
        <p className="font-medium">{targets.length > 1 ? `${targets.length} fichiers utilisés par le site sont refusés : le site sera cassé.` : "Un fichier utilisé par le site est refusé : le site sera cassé."}</p>
        <ul className="space-y-1">
          {targets.slice(0, SHOWN_TARGETS).map(([target, t]) => (
            <li key={target} className="break-words">
              <span className="font-mono">{t.from[0]}</span>
              {t.from.length > 1 ? ` et ${plural(t.from.length - 1, "autre page", "autres pages")} utilisent ` : " utilise "}
              <span className="font-mono">{target}</span>, refusé.
            </li>
          ))}
        </ul>
        {targets.length > SHOWN_TARGETS ? <p>Et {plural(targets.length - SHOWN_TARGETS, "autre fichier", "autres fichiers")}.</p> : null}
        {exceptable ? (
          <p>Ajoutez ces chemins en exception dans l'onglet Serveur (chemin exact de chaque fichier), ou envoyez le site construit.</p>
        ) : null}
        {never ? <p>Les fichiers sensibles ou de développement (.env, .git, node_modules...) ne sont jamais servis : placez ces fichiers ailleurs dans le site, ou envoyez le site construit.</p> : null}
      </div>
    </Banner>
  );
}

/** Code serveur reçu : application dynamique (bloquant) ou scripts isolés (information). */
function ServerApp({ app }: { app: ServerAppNotice }) {
  const files = plural(app.count, `fichier ${app.language}`, `fichiers ${app.language}`);
  return app.kind === "app" ? (
    <Banner level="error" role="alert">
      <p className="font-medium">
        Site dynamique ({app.language}) : il ne peut pas fonctionner sur l'hébergement statique du hub. Envoyez une version statique (maquette,
        export HTML) ou hébergez-le chez un hébergeur {app.language}.
      </p>
      <p className="mt-1">Les {files} restent dans les fichiers de travail mais ne sont jamais publiés (leur code source serait lisible).</p>
    </Banner>
  ) : (
    <Banner level="info" role="status">
      {files} (<span className="break-all font-mono">{app.examples.join(", ")}</span>) : ils ne tournent pas sur la version de travail et n'y sont jamais
      publiés. Ils restent pour la version de production, chez un hébergeur qui les exécute.
    </Banner>
  );
}

export function UploadNotices({ notices }: { notices: UploadNoticesData }) {
  return (
    <>
      {notices.serverApp ? <ServerApp app={notices.serverApp} /> : null}
      {notices.brokenRefs?.length ? <BrokenRefs refs={notices.brokenRefs} /> : null}
    </>
  );
}

/** Résumé après un envoi : alertes en tête, puis reçus et écartés (avant l'envoi par l'interface et par le serveur) avec leurs raisons. */
export function RejectedSummary({
  accepted,
  rejected,
  notices,
  onClose,
}: {
  accepted: number;
  rejected: Array<RejectedFile | SkippedItem>;
  notices?: UploadNoticesData | null;
  onClose: () => void;
}) {
  return (
    <div className="space-y-2">
      {notices ? <UploadNotices notices={notices} /> : null}
      {rejected.length ? (
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
      ) : (
        <Button variant="ghost" onClick={onClose}>
          Fermer
        </Button>
      )}
    </div>
  );
}
