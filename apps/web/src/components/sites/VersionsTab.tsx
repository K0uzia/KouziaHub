import { useState } from "react";
import { toast } from "sonner";
import type { FilesResponse, SiteDetail, VersionEntry } from "@hub/contract";
import { api, errorMessage } from "@/lib/api";
import { formatBytes, formatDateTime, plural } from "@/lib/format";
import { versionSourceLabel, versionStatusLabel } from "@/lib/sites";
import type { Resource } from "@/lib/useResource";
import { Badge, Card, EmptyState } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { MoreMenu } from "@/components/ui/MoreMenu";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

type Pending = { kind: "publish" | "restore"; version: VersionEntry };

/** Historique des versions : republier (retour arrière) ou restaurer dans les fichiers de travail. */
export function VersionsTab({
  site,
  versions,
  onSite,
  onRestored,
}: {
  site: SiteDetail;
  versions: Resource<VersionEntry[]>;
  onSite: (s: SiteDetail) => void;
  onRestored: (files: FilesResponse) => void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const running = site.operation?.status === "RUNNING";
  const current = versions.data?.find((v) => v.current) ?? null;

  async function confirm() {
    if (!pending) return;
    const { kind, version } = pending;
    setBusy(true);
    try {
      if (kind === "publish") {
        const updated = await api<SiteDetail>(`/api/sites/${site.id}/versions/${version.id}/publish`, { method: "POST" });
        onSite(updated);
        toast.success(`Republication de la version ${version.number} lancée`);
      } else {
        const files = await api<FilesResponse>(`/api/sites/${site.id}/versions/${version.id}/restore`, { method: "POST" });
        onRestored(files);
        toast.success(`Version ${version.number} restaurée dans les fichiers de travail`);
      }
      setPending(null);
      void versions.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (versions.loading) {
    return (
      <p role="status" className="py-10 text-center text-sm text-[var(--muted)]">
        Lecture des versions…
      </p>
    );
  }
  if (versions.error && !versions.data) {
    return (
      <Card>
        <EmptyState
          title="L'historique n'a pas pu être lu."
          hint={versions.error}
          action={<Button variant="secondary" onClick={() => void versions.reload()}>Réessayer</Button>}
        />
      </Card>
    );
  }
  const list = [...(versions.data ?? [])].sort((a, b) => b.number - a.number);
  if (list.length === 0) {
    return (
      <Card>
        <EmptyState title="Aucune version pour l'instant" hint="Chaque publication des fichiers de travail crée une version, gardée et republiable." />
      </Card>
    );
  }

  return (
    <>
      <h2 className="sr-only">Historique des versions</h2>
      {/* Liste et non tableau : la note garde toute la largeur (un tableau la réduisait à une lettre par ligne). */}
      <ol aria-label={`Versions de ${site.hostname}, de la plus récente à la plus ancienne`} className="ui-card divide-y divide-[var(--border)] p-0">
        {list.map((v) => {
          const status = versionStatusLabel(v);
          const hasFiles = v.status === "PUBLISHED";
          return (
            <li key={v.id} className="version-row">
              <div className="version-head">
                <h3 className="text-sm font-semibold text-[var(--text)]">Version {v.number}</h3>
                {v.current ? <Badge tone="primary">Servie</Badge> : null}
                <Badge tone={status.tone}>{status.label}</Badge>
              </div>
              <div className="version-body min-w-0">
                <p className={`break-words text-sm ${v.note ? "text-[var(--text)]" : "text-[var(--muted)]"}`}>{v.note ?? "Sans note"}</p>
                {v.error ? <p className="mt-1 text-xs text-[var(--danger)]">{v.error}</p> : null}
              </div>
              <p className="version-meta text-xs text-[var(--muted)]">
                <time dateTime={v.publishedAt ?? v.createdAt}>{formatDateTime(v.publishedAt ?? v.createdAt)}</time>
                <span className="block">{versionSourceLabel(v)}</span>
                <span className="block">
                  {plural(v.fileCount, "fichier", "fichiers")}, {formatBytes(v.totalBytes)}
                </span>
              </p>
              <div className="version-menu">
                <MoreMenu
                  variant="ghost"
                  ariaLabel={`Actions pour la version ${v.number}`}
                  label={null}
                  items={[
                    {
                      label: "Republier cette version",
                      onSelect: () => setPending({ kind: "publish", version: v }),
                      disabled: v.current || !hasFiles || running,
                    },
                    {
                      label: "Restaurer dans les fichiers de travail",
                      onSelect: () => setPending({ kind: "restore", version: v }),
                      disabled: !hasFiles || running,
                    },
                  ]}
                />
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-xs text-[var(--muted)]">
        Une version archivée sans fichiers ne peut plus être republiée. Une opération en cours bloque la republication.
      </p>

      <ConfirmDialog
        open={pending?.kind === "publish"}
        title={pending ? `Republier la version ${pending.version.number} ?` : ""}
        message={
          pending ? (
            <>
              <p>
                <strong className="font-mono">{site.hostname}</strong> servira la version {pending.version.number}
                {current ? ` à la place de la version ${current.number}` : ""}, dans une minute environ.
              </p>
              <dl className="mt-3 grid grid-cols-2 gap-3 rounded-[var(--radius)] border border-[var(--border)] p-3 text-sm">
                <div>
                  <dt className="text-xs text-[var(--muted)]">Actuelle</dt>
                  <dd>{current ? `Version ${current.number}` : "Aucune"}</dd>
                  {current?.note ? <dd className="text-xs text-[var(--muted)]">{current.note}</dd> : null}
                </div>
                <div>
                  <dt className="text-xs text-[var(--muted)]">Choisie</dt>
                  <dd>Version {pending.version.number}</dd>
                  {pending.version.note ? <dd className="text-xs text-[var(--muted)]">{pending.version.note}</dd> : null}
                </div>
              </dl>
              <p className="mt-2 text-[var(--muted)]">Les fichiers de travail ne changent pas.</p>
            </>
          ) : null
        }
        confirmLabel={pending ? `Republier la version ${pending.version.number}` : "Republier"}
        busy={busy}
        onConfirm={() => void confirm()}
        onClose={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending?.kind === "restore"}
        title={pending ? `Restaurer la version ${pending.version.number} ?` : ""}
        message={
          <>
            <p>Les fichiers de travail actuels seront remplacés par ceux de cette version.</p>
            <p className="mt-2 text-[var(--muted)]">
              Le site en ligne ne change pas tant que vous ne publiez pas. Les autres versions sont gardées.
            </p>
          </>
        }
        confirmLabel="Restaurer"
        busy={busy}
        onConfirm={() => void confirm()}
        onClose={() => setPending(null)}
      />
    </>
  );
}
