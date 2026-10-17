import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faChevronRight,
  faFile,
  faFileArrowUp,
  faFolder,
  faFolderPlus,
  faHouse,
  faTrashCan,
} from "@fortawesome/free-solid-svg-icons";
import type { FilesResponse, SiteDetail, UploadResult } from "@hub/contract";
import { api, errorMessage, isAbort, upload } from "@/lib/api";
import { formatBytes, formatDate, formatDateTime, plural } from "@/lib/format";
import {
  canPickFolder,
  cleanDir,
  dirExists,
  filesFromDrop,
  filesFromInput,
  finePointer,
  listDir,
  nameProblem,
  batchSize,
  planBatches,
  type DirEntry,
  type PickedFile,
} from "@/lib/files";
import { useResource } from "@/lib/useResource";
import { useDropTarget } from "@/lib/useDropTarget";
import { Badge, Card, EmptyState } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { MoreMenu } from "@/components/ui/MoreMenu";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Field, Input } from "@/components/ui/Field";
import { Banner } from "@/components/ui/Banner";
import { PublishBar } from "@/components/sites/PublishBar";
import { ZipUpload } from "@/components/sites/ZipUpload";
import { RejectedSummary, UploadProgress, type Progress } from "@/components/sites/UploadFeedback";

type Rejected = { accepted: number; rejected: UploadResult["rejected"] };

function rawUrl(siteId: string, path: string) {
  return `/api/sites/${siteId}/files/raw?path=${encodeURIComponent(path)}`;
}

/** Explorateur des fichiers de travail « comme un FTP » : dossiers, ajout, remplacement, renommage, suppression. */
export function FilesTab({
  site,
  nextVersion,
  refreshKey,
  onSite,
  onFilesChanged,
}: {
  site: SiteDetail;
  nextVersion: number;
  /** Change à la fin d'une opération (publication, restauration) : relecture des fichiers. */
  refreshKey: number;
  onSite: (s: SiteDetail) => void;
  /** Fichiers modifiés : la fiche relit la synthèse (compteurs, « non publié »). */
  onFilesChanged: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const dir = cleanDir(params.get("dossier"));
  const files = useResource<FilesResponse>(`/api/sites/${site.id}/files`);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<Progress | null>(null);
  const [rejected, setRejected] = useState<Rejected | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [renaming, setRenaming] = useState<DirEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [folderPick] = useState(canPickFolder);
  const [desktop] = useState(finePointer);
  const reloadFiles = files.reload;

  useEffect(() => {
    if (refreshKey > 0) void reloadFiles();
  }, [refreshKey, reloadFiles]);

  // Autre dossier : la sélection ne le suit pas.
  useEffect(() => setSelected(new Set()), [dir]);

  const all = useMemo(() => files.data?.files ?? [], [files.data]);
  const entries = useMemo(() => listDir(all, dir), [all, dir]);

  // Dossier vidé ou renommé : retour à la racine.
  useEffect(() => {
    if (files.data && !dirExists(all, dir)) goTo("", true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files.data, all, dir]);

  function dirLink(path: string) {
    const next = new URLSearchParams(params);
    if (path) next.set("dossier", path);
    else next.delete("dossier");
    return `?${next.toString()}`;
  }

  function goTo(path: string, replace = false) {
    const next = new URLSearchParams(params);
    if (path) next.set("dossier", path);
    else next.delete("dossier");
    setParams(next, { replace });
  }

  function applyFiles(next: FilesResponse) {
    files.setData(next);
    setSelected(new Set());
    onFilesChanged();
  }

  async function send(picked: PickedFile[]) {
    if (!picked.length || progress) return;
    const existing = new Set(all.map((f) => f.path));
    const prefix = dir ? `${dir}/` : "";
    // Envoi découpé (nombre de fichiers et poids par requête) ; un fichier trop lourd est écarté avant l'envoi.
    const plan = planBatches(picked, files.data?.limits.maxFileBytes ?? null);
    const totalBytes = plan.batches.reduce((n, batch) => n + batchSize(batch), 0) || 1;
    const ctrl = new AbortController();
    const label = plural(picked.length, "fichier", "fichiers");
    const accepted: string[] = [];
    const rejectedAll = plan.rejected.map((p) => ({ path: prefix + p.path, reason: p.reason }));
    let sent = 0;
    setRejected(null);
    setProgress({ fraction: 0, label, cancel: () => ctrl.abort() });
    try {
      for (const batch of plan.batches) {
        const form = new FormData();
        form.append("dir", dir);
        for (const p of batch) form.append("files", p.file, p.path);
        const bytes = batchSize(batch);
        const res = await upload<UploadResult>(`/api/sites/${site.id}/files`, form, {
          signal: ctrl.signal,
          onProgress: (fraction) =>
            setProgress((p) => (p ? { ...p, fraction: Math.min(1, (sent + fraction * bytes) / totalBytes) } : p)),
        });
        sent += bytes;
        accepted.push(...res.accepted);
        rejectedAll.push(...res.rejected);
        applyFiles(res.files);
      }
    } catch (err) {
      if (isAbort(err))
        toast.info(accepted.length ? `Envoi arrêté après ${plural(accepted.length, "fichier reçu", "fichiers reçus")}` : "Envoi annulé");
      else toast.error(errorMessage(err, "Envoi impossible."));
    } finally {
      setProgress(null);
    }
    const replaced = accepted.filter((p) => existing.has(p)).length;
    const added = accepted.length - replaced;
    const parts = [
      added ? plural(added, "fichier ajouté", "fichiers ajoutés") : null,
      replaced ? plural(replaced, "fichier remplacé", "fichiers remplacés") : null,
    ].filter(Boolean);
    if (parts.length) toast.success(parts.join(", "));
    if (rejectedAll.length) {
      setRejected({ accepted: accepted.length, rejected: rejectedAll });
      toast.warning(plural(rejectedAll.length, "fichier écarté", "fichiers écartés"));
    }
  }

  const drop = useDropTarget((dt) => {
    void filesFromDrop(dt)
      .then(send)
      .catch(() => toast.error("Ces éléments n'ont pas pu être lus. Essayez avec « Ajouter des fichiers »."));
  }, desktop && !progress);

  async function remove(paths: string[]) {
    setBusy(true);
    try {
      const res = await api<FilesResponse>(`/api/sites/${site.id}/files/delete`, { method: "POST", json: { paths } });
      applyFiles(res);
      setConfirmDelete(null);
      toast.success(`${plural(paths.length, "élément supprimé", "éléments supprimés")}`);
    } catch (err) {
      toast.error(errorMessage(err, "Suppression impossible."));
    } finally {
      setBusy(false);
    }
  }

  function download(path: string) {
    const a = document.createElement("a");
    a.href = rawUrl(site.id, path);
    a.download = path.split("/").pop() ?? "";
    a.click();
  }

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const allSelected = entries.length > 0 && entries.every((e) => selected.has(e.path));
  const crumbs = dir ? dir.split("/") : [];

  const addButtons = (
    <>
      <Button variant="secondary" onClick={() => fileInput.current?.click()} disabled={!!progress}>
        <FontAwesomeIcon icon={faFileArrowUp} className="h-3.5 w-3.5" aria-hidden />
        Ajouter des fichiers
      </Button>
      {folderPick ? (
        <Button variant="secondary" onClick={() => folderInput.current?.click()} disabled={!!progress}>
          <FontAwesomeIcon icon={faFolderPlus} className="h-3.5 w-3.5" aria-hidden />
          Ajouter un dossier
        </Button>
      ) : null}
    </>
  );

  const limits = files.data?.limits;
  const where = dir ? `dans « ${dir} »` : "à la racine";

  return (
    <div className="space-y-5">
      {files.data?.workingDirty ? (
        <PublishBar site={site} hasIndex={files.data.hasIndex} nextVersion={nextVersion} onSite={onSite} />
      ) : null}

      <Card className="p-0">
        <div
          {...drop.handlers}
          data-over={drop.over}
          className="dropzone dropzone-quiet p-4 sm:p-5"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h2 className="text-base font-semibold">Fichiers de travail</h2>
              <nav aria-label="Dossiers" className="mt-1">
                <ol className="flex min-w-0 flex-wrap items-center gap-x-1 text-sm">
                  <li>
                    {dir ? (
                      <Link to={dirLink("")} className="link inline-flex min-h-11 items-center gap-1.5 px-1">
                        <FontAwesomeIcon icon={faHouse} className="h-3.5 w-3.5" aria-hidden />
                        Racine
                      </Link>
                    ) : (
                      <span aria-current="location" className="inline-flex min-h-11 items-center gap-1.5 px-1 text-[var(--text)]">
                        <FontAwesomeIcon icon={faHouse} className="h-3.5 w-3.5" aria-hidden />
                        Racine
                      </span>
                    )}
                  </li>
                  {crumbs.map((name, i) => {
                    const path = crumbs.slice(0, i + 1).join("/");
                    const last = i === crumbs.length - 1;
                    return (
                      <li key={path} className="flex min-w-0 items-center gap-1">
                        <FontAwesomeIcon icon={faChevronRight} className="h-2.5 w-2.5 text-[var(--muted)]" aria-hidden />
                        {last ? (
                          <span aria-current="location" className="inline-flex min-h-11 min-w-0 items-center break-all px-1 font-medium text-[var(--text)]">
                            {name}
                          </span>
                        ) : (
                          <Link to={dirLink(path)} className="link inline-flex min-h-11 min-w-0 items-center break-all px-1">
                            {name}
                          </Link>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </nav>
            </div>
            <div className="flex flex-wrap gap-2 [&>*]:flex-[1_1_10rem] sm:[&>*]:flex-none">{addButtons}</div>
          </div>

          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void send(filesFromInput(e.target.files));
              e.target.value = "";
            }}
          />
          {folderPick ? (
            <input
              ref={folderInput}
              type="file"
              hidden
              {...{ webkitdirectory: "", directory: "" }}
              onChange={(e) => {
                void send(filesFromInput(e.target.files));
                e.target.value = "";
              }}
            />
          ) : null}

          <div className="mt-4 space-y-3">
            {progress ? <UploadProgress progress={progress} /> : null}
            {rejected ? <RejectedSummary accepted={rejected.accepted} rejected={rejected.rejected} onClose={() => setRejected(null)} /> : null}
            {files.error && files.data ? (
              <Banner level="warning" action={<Button variant="ghost" onClick={() => void files.reload()}>Réessayer</Button>}>
                Dernière lecture impossible : {files.error}
              </Banner>
            ) : null}
          </div>

          {files.loading ? (
            <p role="status" className="py-10 text-center text-sm text-[var(--muted)]">
              Lecture des fichiers…
            </p>
          ) : files.error && !files.data ? (
            <EmptyState
              title="Les fichiers n'ont pas pu être lus."
              hint={files.error}
              action={<Button variant="secondary" onClick={() => void files.reload()}>Réessayer</Button>}
            />
          ) : entries.length === 0 ? (
            <EmptyState
              icon={<FontAwesomeIcon icon={faFolder} className="h-5 w-5" aria-hidden />}
              title="Aucun fichier de travail"
              hint={
                desktop
                  ? "Glissez ici les fichiers ou le dossier du site, ou envoyez-le en zip plus bas. La page d'accueil doit s'appeler index.html."
                  : "Ajoutez les fichiers du site, ou envoyez-le en zip plus bas. La page d'accueil doit s'appeler index.html."
              }
            />
          ) : (
            <div className="mt-2">
              <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-[var(--border)] pb-2">
                <label className="inline-flex min-h-11 cursor-pointer items-center gap-3 pr-2 text-sm text-[var(--muted)]">
                  <span className="grid h-11 w-11 place-items-center">
                    <input
                      type="checkbox"
                      className="ui-check"
                      checked={allSelected}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.path)))}
                    />
                  </span>
                  Tout sélectionner
                </label>
                {selected.size > 0 ? (
                  <div className="ml-auto flex flex-wrap items-center gap-2" role="group" aria-label="Sélection">
                    <span className="text-sm text-[var(--text)]" aria-live="polite">
                      {plural(selected.size, "élément sélectionné", "éléments sélectionnés")}
                    </span>
                    <Button variant="danger" onClick={() => setConfirmDelete([...selected])}>
                      <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" aria-hidden />
                      Supprimer
                    </Button>
                  </div>
                ) : null}
              </div>
              <ul aria-label={`Contenu du dossier ${dir || "racine"}`}>
                {entries.map((entry) => (
                  <li key={entry.path} className="file-row">
                    <span className="grid h-11 w-11 place-items-center">
                      <input
                        type="checkbox"
                        className="ui-check"
                        checked={selected.has(entry.path)}
                        onChange={() => toggle(entry.path)}
                        aria-label={`Sélectionner ${entry.name}`}
                      />
                    </span>
                    <div className="min-w-0">
                      {entry.type === "folder" ? (
                        <Link to={dirLink(entry.path.replace(/\/$/, ""))} className="file-name link">
                          <FontAwesomeIcon icon={faFolder} className="h-4 w-4 shrink-0 text-[var(--primary)]" aria-hidden />
                          <span className="min-w-0 break-all">{entry.name}</span>
                          <span className="sr-only">, dossier</span>
                        </Link>
                      ) : (
                        <a href={rawUrl(site.id, entry.path)} download={entry.name} className="file-name text-[var(--text)] hover:text-[var(--primary-hover)]">
                          <FontAwesomeIcon icon={faFile} className="h-4 w-4 shrink-0 text-[var(--muted)]" aria-hidden />
                          <span className="min-w-0 break-all">{entry.name}</span>
                          <span className="sr-only">, télécharger</span>
                          {entry.path === site.serverConfig.path && site.serverConfig.status !== "missing" ? (
                            <Badge tone={site.serverConfig.status === "generated" ? "green" : "amber"}>
                              {site.serverConfig.status === "generated" ? "généré" : "modifié"}
                            </Badge>
                          ) : null}
                        </a>
                      )}
                      <p className="text-xs text-[var(--muted)] sm:hidden">
                        {entry.type === "folder" ? `${plural(entry.count, "fichier", "fichiers")}, ` : ""}
                        {formatBytes(entry.size)}, {formatDate(entry.updatedAt)}
                      </p>
                    </div>
                    <span className="hidden text-right text-sm tabular-nums text-[var(--muted)] sm:block">
                      {entry.type === "folder" ? `${plural(entry.count, "fichier", "fichiers")}, ` : ""}
                      {formatBytes(entry.size)}
                    </span>
                    <span className="hidden text-sm text-[var(--muted)] md:block">{formatDateTime(entry.updatedAt)}</span>
                    <MoreMenu
                      variant="ghost"
                      ariaLabel={`Actions pour ${entry.name}`}
                      label={null}
                      items={[
                        ...(entry.type === "file" ? [{ label: "Télécharger", onSelect: () => download(entry.path) }] : []),
                        { label: "Renommer", onSelect: () => setRenaming(entry) },
                        { label: "Supprimer", danger: true, onSelect: () => setConfirmDelete([entry.path]) },
                      ]}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {desktop && entries.length > 0 ? (
            <p className="mt-4 text-center text-xs text-[var(--muted)]">
              {drop.over ? `Déposez pour ajouter ${where}.` : `Glissez des fichiers ou un dossier ici pour les ajouter ${where}. Un fichier du même nom est remplacé.`}
            </p>
          ) : entries.length > 0 ? (
            <p className="mt-4 text-xs text-[var(--muted)]">Un fichier ajouté sous le même nom remplace l'ancien.</p>
          ) : null}
          {limits ? (
            <p className="mt-1 text-center text-xs text-[var(--muted)]">
              Au plus {plural(limits.maxFiles, "fichier", "fichiers")}, {formatBytes(limits.maxFileBytes)} par fichier.
            </p>
          ) : null}
          {drop.over ? (
            <div aria-hidden className="pointer-events-none absolute inset-2 grid place-items-center rounded-[var(--radius)] bg-[var(--bg)]/80">
              <p className="flex items-center gap-2 text-base font-semibold text-[var(--primary)]">
                <FontAwesomeIcon icon={faFileArrowUp} className="h-5 w-5" />
                Déposer pour ajouter {where}
              </p>
            </div>
          ) : null}
        </div>
      </Card>

      <ZipUpload
        siteId={site.id}
        fileCount={all.length}
        maxZipBytes={limits?.maxZipBytes ?? null}
        busy={!!progress}
        onDone={(res) => applyFiles(res.files)}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        title={confirmDelete && confirmDelete.length > 1 ? `Supprimer ${confirmDelete.length} éléments ?` : "Supprimer cet élément ?"}
        message={
          <>
            <ul className="mb-2 max-h-40 space-y-0.5 overflow-y-auto font-mono text-sm">
              {(confirmDelete ?? []).slice(0, 8).map((p) => (
                <li key={p} className="break-all">
                  {p}
                </li>
              ))}
              {(confirmDelete?.length ?? 0) > 8 ? <li className="font-sans text-[var(--muted)]">et {confirmDelete!.length - 8} autres</li> : null}
            </ul>
            <p className="text-[var(--muted)]">
              Ils sont retirés des fichiers de travail (un dossier avec tout son contenu). Le site en ligne ne change qu'à la prochaine publication.
            </p>
          </>
        }
        confirmLabel={confirmDelete && confirmDelete.length > 1 ? `Supprimer ${confirmDelete.length} éléments` : "Supprimer"}
        danger
        busy={busy}
        onConfirm={() => confirmDelete && void remove(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
      />

      <RenameDialog
        key={renaming?.path ?? "none"}
        siteId={site.id}
        entry={renaming}
        siblings={entries}
        onClose={() => setRenaming(null)}
        onDone={(res) => {
          applyFiles(res);
          setRenaming(null);
        }}
      />
    </div>
  );
}

function RenameDialog({
  siteId,
  entry,
  siblings,
  onClose,
  onDone,
}: {
  siteId: string;
  entry: DirEntry | null;
  siblings: DirEntry[];
  onClose: () => void;
  onDone: (res: FilesResponse) => void;
}) {
  const [name, setName] = useState(entry?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Nom sélectionné sans l'extension : on retape le nom, l'extension reste.
  useEffect(() => {
    if (!entry) return;
    const el = inputRef.current;
    if (!el) return;
    const dot = entry.type === "file" ? entry.name.lastIndexOf(".") : -1;
    el.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  }, [entry]);

  if (!entry) return null;
  const parent = entry.path.replace(/\/$/, "").split("/").slice(0, -1).join("/");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!entry) return;
    const trimmed = name.trim();
    const problem =
      nameProblem(trimmed) ??
      (trimmed !== entry.name && siblings.some((s) => s.name === trimmed) ? "Un élément porte déjà ce nom dans ce dossier." : null);
    if (problem) {
      setError(problem);
      inputRef.current?.focus();
      return;
    }
    if (trimmed === entry.name) {
      onClose();
      return;
    }
    const to = `${parent ? `${parent}/` : ""}${trimmed}${entry.type === "folder" ? "/" : ""}`;
    setBusy(true);
    try {
      const res = await api<FilesResponse>(`/api/sites/${siteId}/files/move`, { method: "POST", json: { from: entry.path, to } });
      toast.success(`Renommé en « ${trimmed} »`);
      onDone(res);
    } catch (err) {
      setError(errorMessage(err, "Renommage impossible."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={busy ? () => undefined : onClose} title={entry.type === "folder" ? "Renommer le dossier" : "Renommer le fichier"}>
      <form onSubmit={onSubmit} noValidate>
        <Field label="Nouveau nom" error={error ?? undefined}>
          <Input
            ref={inputRef}
            value={name}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </Field>
        <p className="mt-2 text-xs text-[var(--muted)]">
          Les liens des pages vers {entry.type === "folder" ? "ce dossier" : "ce fichier"} ne sont pas modifiés.
        </p>
        <ModalActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Annuler
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Renommage…" : "Renommer"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
