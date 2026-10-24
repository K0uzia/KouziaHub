import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
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
import type { FilesResponse, SiteDetail, UploadSession, VersionCheck } from "@hub/contract";
import { checkVersion } from "@hub/version-check";
import { api, errorMessage, isAbort } from "@/lib/api";
import { cancelSession, openSessions, sendFiles } from "@/lib/uploadSession";
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
  prepareSelection,
  stripSingleRoot,
  type PreparedSelection,
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
import { VersionCheckNotice } from "@/components/sites/VersionCheckNotice";
import { ZipUpload } from "@/components/sites/ZipUpload";
import { hasNotices, RejectedSummary, SkippedList, UploadProgress, type Progress, type SkippedItem, type UploadNoticesData } from "@/components/sites/UploadFeedback";

type Rejected = { accepted: number; rejected: SkippedItem[]; notices?: UploadNoticesData };

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
  const [preparing, setPreparing] = useState<{ prepared: PreparedSelection; skipped: SkippedItem[] } | null>(null);
  /** Projet non construit reconnu sur le dernier envoi (fichiers écartés compris). */
  const [projectCheck, setProjectCheck] = useState<VersionCheck | null>(null);
  const [confirmClean, setConfirmClean] = useState(false);
  /** Sources d'un projet non construit choisies : prévenu avant l'envoi. */
  const [unbuilt, setUnbuilt] = useState<{ check: VersionCheck; picked: PickedFile[] } | null>(null);
  /** Site complet envoyé sur des fichiers existants : choix « Remplacer tout » ou « Ajouter ». */
  const [askMode, setAskMode] = useState<{ toSend: PickedFile[]; skipped: SkippedItem[]; label?: string } | null>(null);
  /** Envois interrompus (sessions ouvertes du serveur) et celui que l'utilisateur reprend. */
  const [interrupted, setInterrupted] = useState<UploadSession[]>([]);
  const [resume, setResume] = useState<UploadSession | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [renaming, setRenaming] = useState<DirEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const checkId = useId();
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

  /** Choix d'abord : écartés avant l'envoi, dossier de projet reconnu (proposition « seulement dist/ »). */
  async function send(picked: PickedFile[], confirmedUnbuilt = false) {
    if (!picked.length || progress) return;
    // Mêmes règles que le serveur, hébergement compris (un site PHP garde src/ et composer.json).
    const prepared = prepareSelection(picked, files.data?.limits.maxFileBytes ?? null, { allow: site.devFilesAllowed, hosting: site.hosting });
    const skipped = prepared.excluded.map((e) => ({ path: (dir ? `${dir}/` : "") + e.path, reason: e.reason, size: e.size }));
    // Reprise d'un envoi « seulement dist/ » : même choix, sans redemander.
    if (resume && prepared.project && prepared.project.files.length === resume.included.length) {
      void transfer(prepared.project.files, [], undefined, { complete: false, mode: resume.mode === "replace" ? "replace" : "merge" });
      return;
    }
    // Reprise d'un « Remplacer tout le contenu » : dossier racine retiré comme au premier envoi.
    if (resume?.mode === "replace") {
      void transfer(stripSingleRoot(prepared.send).files, skipped, undefined, { complete: false, mode: "replace" });
      return;
    }
    if (prepared.project && resume === null) {
      setPreparing({ prepared, skipped });
      return;
    }
    // Sources d'un projet sans résultat construit : dit avant l'envoi (package.json, astro.config... ne partent pas,
    // ils ne seraient plus visibles après). Lu sur toute la sélection, dossier racine retiré.
    if (!confirmedUnbuilt && resume === null && dir === "") {
      const asSite = stripSingleRoot(picked).files;
      const pkg = asSite.find((f) => f.path === "package.json");
      const pkgText = pkg && pkg.file.size <= 256 * 1024 ? await pkg.file.text().catch(() => null) : null;
      const check = checkVersion(asSite.map((f) => f.path), pkgText);
      if (check?.code === "unbuilt") {
        setUnbuilt({ check, picked });
        return;
      }
    }
    // Un dossier entier (un seul dossier en tête des chemins) : le site complet, « Remplacer » proposé.
    void transfer(prepared.send, skipped, undefined, { complete: stripSingleRoot(prepared.send).root !== null });
  }

  /** Fichiers de travail du site (le .htaccess généré par le hub, gardé par « Remplacer », ne compte pas). */
  const siteFiles = all.filter((f) => !(f.path === ".htaccess" && site.serverConfig.status === "generated"));

  async function transfer(
    toSend: PickedFile[],
    skipped: SkippedItem[],
    label?: string,
    opts: { complete: boolean; mode?: "replace" | "merge" } = { complete: false },
  ) {
    setPreparing(null);
    // Site complet envoyé à la racine alors qu'il y a déjà des fichiers : remplacer ou ajouter ? (rien ne se mélange sans le dire)
    if (!opts.mode && opts.complete && !resume && dir === "" && siteFiles.length > 0 && toSend.length > 0) {
      setAskMode({ toSend, skipped, label });
      return;
    }
    setAskMode(null);
    const mode = opts.mode ?? "merge";
    setRejected(null);
    if (toSend.length === 0) {
      if (skipped.length) {
        setRejected({ accepted: 0, rejected: skipped });
        toast.warning(`Rien à envoyer : ${plural(skipped.length, "fichier écarté", "fichiers écartés")}`);
      }
      return;
    }
    const existing = new Set(all.map((f) => f.path));
    const ctrl = new AbortController();
    const text = label ?? plural(toSend.length, "fichier", "fichiers");
    let opened: UploadSession | null = null;
    const resuming = resume;
    let cancelled = false;
    setProgress({
      label: text,
      state: { phase: "hash", bytesDone: 0, bytesTotal: 0, filesDone: 0, filesTotal: toSend.length },
      cancel: () => {
        cancelled = true;
        ctrl.abort();
      },
    });
    try {
      const res = await sendFiles({
        siteId: site.id,
        dir,
        files: toSend,
        mode,
        resume: resuming,
        signal: ctrl.signal,
        onSession: (s) => (opened = s),
        onProgress: (state) => setProgress((p) => (p ? { ...p, state } : p)),
      });
      setResume(null);
      setInterrupted([]);
      applyFiles(res.files);
      setProjectCheck(res.projectCheck ?? null);
      const replaced = res.accepted.filter((p) => existing.has(p)).length;
      const added = res.accepted.length - replaced;
      const parts = [
        added ? plural(added, "fichier ajouté", "fichiers ajoutés") : null,
        replaced ? plural(replaced, "fichier remplacé", "fichiers remplacés") : null,
        res.removed ? plural(res.removed, "ancien fichier retiré", "anciens fichiers retirés") : null,
      ].filter(Boolean);
      if (parts.length) toast.success(parts.join(", "));
      const allSkipped = [...skipped, ...res.rejected];
      const notices = { brokenRefs: res.brokenRefs, serverApp: res.serverApp };
      if (allSkipped.length || hasNotices(notices)) setRejected({ accepted: res.accepted.length, rejected: allSkipped, notices });
      if (allSkipped.length) toast.warning(plural(allSkipped.length, "fichier écarté", "fichiers écartés"));
    } catch (err) {
      const session = opened as UploadSession | null;
      if (isAbort(err) && cancelled) {
        // « Annuler l'envoi » : la session et ses morceaux sont supprimés.
        if (session) await cancelSession(site.id, session.id).catch(() => undefined);
        setResume(null);
        toast.info("Envoi annulé");
      } else {
        toast.error(errorMessage(err, "Envoi impossible."));
        if (skipped.length) setRejected({ accepted: 0, rejected: skipped });
        // Coupure : la session reste sur le serveur ; montrée tout de suite, état exact relu dès que possible.
        if (session) setInterrupted([session]);
      }
      void refreshInterrupted();
    } finally {
      setProgress(null);
    }
  }

  async function refreshInterrupted() {
    try {
      setInterrupted((await openSessions(site.id)).filter((x) => x.kind === "files"));
    } catch {
      /* état facultatif : l'envoi reste possible */
    }
  }

  useEffect(() => {
    void refreshInterrupted();
    // Retour du réseau : l'état des morceaux reçus est relu.
    const onOnline = () => void refreshInterrupted();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.id]);

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

  async function cleanDev() {
    setBusy(true);
    try {
      const count = files.data?.devFiles.length ?? 0;
      const res = await api<FilesResponse>(`/api/sites/${site.id}/files/clean-dev`, { method: "POST", json: { confirm: true } });
      applyFiles(res);
      setConfirmClean(false);
      toast.success(plural(count, "fichier de développement retiré", "fichiers de développement retirés"));
    } catch (err) {
      toast.error(errorMessage(err, "Nettoyage impossible."));
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
      {projectCheck ? <VersionCheckNotice check={projectCheck} /> : null}
      {files.data?.versionCheck ? <VersionCheckNotice check={files.data.versionCheck} id={checkId} /> : null}
      {files.data?.devFiles.length ? (
        <Banner
          level="warning"
          action={
            <Button variant="secondary" onClick={() => setConfirmClean(true)} disabled={busy}>
              Nettoyer
            </Button>
          }
        >
          {plural(files.data.devFiles.length, "fichier de développement reste", "fichiers de développement restent")} dans la version de
          travail (<span className="font-mono break-all">{files.data.devFiles.slice(0, 3).join(", ")}</span>
          {files.data.devFiles.length > 3 ? "..." : ""}) :{" "}
          {files.data.devFiles.length > 1 ? "ils ne sont plus servis, mais n'ont rien à faire dans le site." : "il n'est plus servi, mais n'a rien à faire dans le site."}
        </Banner>
      ) : null}
      {files.data?.workingDirty ? (
        <PublishBar site={site} check={files.data.versionCheck} checkId={checkId} nextVersion={nextVersion} onSite={onSite} />
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
            {!progress && interrupted.length ? (
              <Banner
                level="warning"
                action={
                  <Button
                    variant="ghost"
                    onClick={() => {
                      const s = interrupted[0]!;
                      void cancelSession(site.id, s.id)
                        .catch(() => undefined)
                        .then(() => {
                          if (resume?.id === s.id) setResume(null);
                          toast.info("Envoi interrompu annulé");
                          return refreshInterrupted();
                        });
                    }}
                  >
                    Annuler cet envoi
                  </Button>
                }
              >
                <p className="font-medium">
                  Un envoi n'a pas abouti : {plural(interrupted[0]!.files.length, "fichier", "fichiers")}, {formatBytes(interrupted[0]!.totalBytes)},{" "}
                  {interrupted[0]!.received.length} morceau(x) reçu(s) sur {interrupted[0]!.chunkCount}.
                </p>
                <p className="mt-1">
                  {resume?.id === interrupted[0]!.id
                    ? "Choisissez maintenant la même sélection : seuls les morceaux manquants partiront."
                    : "Pour reprendre, choisissez à nouveau exactement les mêmes fichiers ou le même dossier."}
                </p>
                {resume?.id !== interrupted[0]!.id ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={() => setResume(interrupted[0]!)}>
                      Reprendre cet envoi
                    </Button>
                  </div>
                ) : null}
              </Banner>
            ) : null}
            {rejected ? <RejectedSummary accepted={rejected.accepted} rejected={rejected.rejected} notices={rejected.notices} onClose={() => setRejected(null)} /> : null}
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
                        </a>
                      )}
                      {/* Hors du lien : il ne rétrécit plus le nom et ne s'ajoute plus au nom du lien ; passe à la ligne si la place manque. */}
                      {entry.type !== "folder" && entry.path === site.serverConfig.path && site.serverConfig.status !== "missing" ? (
                        <Badge tone={site.serverConfig.status === "generated" ? "green" : "amber"} className="ml-2 align-middle">
                          {site.serverConfig.status === "generated" ? "généré" : "modifié"}
                        </Badge>
                      ) : null}
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
        publicDir={site.php ? site.php.publicDir : null}
        fileCount={siteFiles.length}
        maxZipBytes={limits?.maxZipBytes ?? null}
        busy={!!progress}
        onDone={(res) => {
          applyFiles(res.files);
          setProjectCheck(res.projectCheck ?? null);
        }}
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

      <Modal
        open={preparing !== null}
        onClose={() => setPreparing(null)}
        title="Dossier de projet reconnu"
        wide
        description="Ce dossier contient les sources d'un site et son résultat construit."
      >
        {preparing?.prepared.project ? (
          <div className="space-y-4 text-sm">
            <p>
              Le site à publier est dans <span className="font-mono">{preparing.prepared.project.root ? `${preparing.prepared.project.root}/` : ""}{preparing.prepared.project.output}/</span>{" "}
              : {plural(preparing.prepared.project.files.length, "fichier", "fichiers")}, {formatBytes(preparing.prepared.project.bytes)}. Son contenu sera placé{" "}
              {dir ? `dans « ${dir} »` : "à la racine du site"}.
            </p>
            <p className="text-[var(--muted)]">
              Le reste ({plural(preparing.prepared.send.length - preparing.prepared.project.files.length, "fichier", "fichiers")} de sources) ne sert pas au site
              en ligne.
            </p>
            {preparing.skipped.length ? (
              <div>
                <p className="font-medium">Jamais envoyés :</p>
                <SkippedList items={preparing.skipped} />
              </div>
            ) : null}
            <ModalActions>
              <Button variant="secondary" onClick={() => void transfer(preparing.prepared.send, preparing.skipped, undefined, { complete: true })}>
                Tout envoyer ({plural(preparing.prepared.send.length, "fichier", "fichiers")})
              </Button>
              <Button data-autofocus onClick={() => void transfer(preparing.prepared.project!.files, [], `${preparing.prepared.project!.output}/`, { complete: true })}>
                Envoyer seulement {preparing.prepared.project.output}/ ({plural(preparing.prepared.project.files.length, "fichier", "fichiers")},{" "}
                {formatBytes(preparing.prepared.project.bytes)})
              </Button>
            </ModalActions>
          </div>
        ) : null}
      </Modal>

      <Modal open={unbuilt !== null} onClose={() => setUnbuilt(null)} title="Ce dossier n'est pas encore un site" wide>
        {unbuilt ? (
          <div className="space-y-4 text-sm">
            <VersionCheckNotice check={unbuilt.check} />
            <p>
              Les fichiers de développement (package.json, configuration, src/) ne partent pas : envoyés tels quels, ces sources ne
              donneraient pas de site.
            </p>
            <ModalActions>
              <Button
                variant="secondary"
                onClick={() => {
                  const picked = unbuilt.picked;
                  setUnbuilt(null);
                  void send(picked, true);
                }}
              >
                Envoyer quand même
              </Button>
              <Button data-autofocus onClick={() => setUnbuilt(null)}>
                Annuler
              </Button>
            </ModalActions>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={confirmClean}
        title="Nettoyer les fichiers de développement ?"
        message={
          <>
            <p>
              {plural(files.data?.devFiles.length ?? 0, "fichier sera retiré", "fichiers seront retirés")} de la version de travail :{" "}
              <span className="font-mono break-all">{(files.data?.devFiles ?? []).slice(0, 10).join(", ")}</span>
              {(files.data?.devFiles.length ?? 0) > 10 ? "..." : ""}
            </p>
            <p className="mt-2 text-[var(--muted)]">
              Un fichier dont le site a vraiment besoin s'autorise dans l'onglet Serveur (Règles du site). Le site en ligne change à la
              prochaine publication.
            </p>
          </>
        }
        confirmLabel="Nettoyer"
        danger
        busy={busy}
        onConfirm={() => void cleanDev()}
        onClose={() => setConfirmClean(false)}
      />

      {askMode ? (
        <ReplaceOrAddDialog
          siteFiles={siteFiles.map((f) => f.path)}
          toSend={askMode.toSend}
          onReplace={() => void transfer(stripSingleRoot(askMode.toSend).files, askMode.skipped, askMode.label, { complete: false, mode: "replace" })}
          onAdd={() => void transfer(askMode.toSend, askMode.skipped, askMode.label, { complete: false, mode: "merge" })}
          onClose={() => setAskMode(null)}
        />
      ) : null}

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

/**
 * Envoi d'un site complet sur une version de travail qui a déjà des fichiers : « Remplacer tout le contenu » par
 * défaut (rien de l'ancien ne reste, ex. un index.html d'un autre projet), ou « Ajouter et remplacer les fichiers
 * en double » (comportement de l'explorateur). Le nombre de fichiers retirés est dit avant.
 */
function ReplaceOrAddDialog({
  siteFiles,
  toSend,
  onReplace,
  onAdd,
  onClose,
}: {
  siteFiles: string[];
  toSend: PickedFile[];
  onReplace: () => void;
  onAdd: () => void;
  onClose: () => void;
}) {
  const { files: asSite, root } = stripSingleRoot(toSend);
  const incoming = new Set(asSite.map((f) => f.path));
  const removed = siteFiles.filter((p) => !incoming.has(p));
  const addPaths = new Set(toSend.map((f) => f.path));
  const duplicates = siteFiles.filter((p) => addPaths.has(p)).length;
  return (
    <Modal open onClose={onClose} title="Remplacer le contenu du site ?" wide description={`La version de travail contient déjà ${plural(siteFiles.length, "fichier", "fichiers")}.`}>
      <div className="space-y-4 text-sm">
        <div>
          <p className="font-medium text-[var(--text)]">Remplacer tout le contenu (conseillé pour un site complet)</p>
          <p className="mt-1">
            {removed.length ? (
              <>
                {plural(removed.length, "fichier actuel sera retiré", "fichiers actuels seront retirés")}
                {removed.length <= 5 ? (
                  <>
                    {" "}
                    : <span className="font-mono break-all">{removed.join(", ")}</span>
                  </>
                ) : null}
                .
              </>
            ) : (
              "Aucun fichier actuel ne sera retiré."
            )}{" "}
            {root ? (
              <>
                Le contenu du dossier <span className="font-mono">{root}/</span> devient la racine du site.
              </>
            ) : null}
          </p>
        </div>
        <div>
          <p className="font-medium text-[var(--text)]">Ajouter et remplacer les fichiers en double</p>
          <p className="mt-1">
            Rien n'est retiré{duplicates ? `, ${plural(duplicates, "fichier en double est remplacé", "fichiers en double sont remplacés")}` : ""}
            {root ? (
              <>
                {" "}
                ; les fichiers arrivent dans le dossier <span className="font-mono">{root}/</span>
              </>
            ) : null}
            . Les anciens fichiers restent mêlés aux nouveaux.
          </p>
        </div>
        <p className="text-[var(--muted)]">Les versions déjà publiées ne changent pas : le site en ligne ne change qu'à la prochaine publication.</p>
        <ModalActions>
          <Button variant="secondary" onClick={onAdd}>
            Ajouter et remplacer les fichiers en double
          </Button>
          <Button data-autofocus onClick={onReplace}>
            Remplacer tout le contenu
          </Button>
        </ModalActions>
      </div>
    </Modal>
  );
}
