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
      <div className="ui-card ui-table-wrap max-md:border-0 max-md:bg-transparent max-md:shadow-none">
        <table className="ui-table ui-table-stack">
          <caption className="sr-only">Versions de {site.hostname}, de la plus récente à la plus ancienne</caption>
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Note</th>
              <th scope="col">Date</th>
              <th scope="col">Source</th>
              <th scope="col">Taille</th>
              <th scope="col">État</th>
              <th scope="col" className="col-actions">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((v) => {
              const status = versionStatusLabel(v);
              const hasFiles = v.status === "PUBLISHED";
              return (
                <tr key={v.id}>
                  <td data-label="Version" className="nowrap">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-[var(--text)]">Version {v.number}</span>
                      {v.current ? <Badge tone="primary">Servie</Badge> : null}
                    </span>
                  </td>
                  <td data-label="Note" className="wrap">
                    {v.note ? <span className="text-[var(--text)]">{v.note}</span> : <span className="text-[var(--muted)]">Sans note</span>}
                  </td>
                  <td data-label="Date" className="nowrap">
                    {formatDateTime(v.publishedAt ?? v.createdAt)}
                  </td>
                  <td data-label="Source" className="wrap">
                    {versionSourceLabel(v)}
                  </td>
                  <td data-label="Taille" className="nowrap">
                    {plural(v.fileCount, "fichier", "fichiers")}, {formatBytes(v.totalBytes)}
                  </td>
                  <td data-label="État" className="wrap">
                    <Badge tone={status.tone}>{status.label}</Badge>
                    {v.error ? <span className="mt-1 block text-xs text-[var(--danger)]">{v.error}</span> : null}
                  </td>
                  <td className="col-actions">
                    <MoreMenu
                      variant="ghost"
                      ariaLabel={`Actions pour la version ${v.number}`}
                      label={<span className="md:sr-only">Actions</span>}
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
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
