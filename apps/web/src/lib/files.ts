import type { WorkingFileEntry } from "@hub/contract";
import { checkSitePath, fileTooBigReason, type ClassifyOptions } from "@hub/site-paths";

export type DirEntry =
  | { type: "folder"; name: string; path: string; size: number; count: number; updatedAt: string }
  | { type: "file"; name: string; path: string; size: number; updatedAt: string };

/** Dossier normalisé : sans barre au début ni à la fin (« » pour la racine). */
export function cleanDir(dir: string | null | undefined): string {
  return (dir ?? "").replace(/^\/+|\/+$/g, "");
}

/** Contenu direct d'un dossier : sous-dossiers (taille et nombre cumulés) puis fichiers, par ordre alphabétique. */
export function listDir(files: WorkingFileEntry[], dir: string): DirEntry[] {
  const prefix = dir ? `${dir}/` : "";
  const folders = new Map<string, Extract<DirEntry, { type: "folder" }>>();
  const out: DirEntry[] = [];
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) {
      out.push({ type: "file", name: rest, path: f.path, size: f.size, updatedAt: f.updatedAt });
      continue;
    }
    const name = rest.slice(0, slash);
    const existing = folders.get(name);
    if (existing) {
      existing.size += f.size;
      existing.count += 1;
      if (f.updatedAt > existing.updatedAt) existing.updatedAt = f.updatedAt;
    } else {
      folders.set(name, { type: "folder", name, path: `${prefix}${name}/`, size: f.size, count: 1, updatedAt: f.updatedAt });
    }
  }
  const byName = (a: DirEntry, b: DirEntry) => a.name.localeCompare(b.name, "fr", { numeric: true });
  return [...[...folders.values()].sort(byName), ...out.sort(byName)];
}

/** Le dossier existe-t-il encore (sinon l'explorateur remonte à la racine) ? */
export function dirExists(files: WorkingFileEntry[], dir: string): boolean {
  return !dir || files.some((f) => f.path.startsWith(`${dir}/`));
}

/** Nom de fichier ou de dossier refusé localement (le serveur garde le dernier mot). */
export function nameProblem(name: string): string | null {
  if (!name.trim()) return "Indiquez un nom.";
  if (name.includes("/") || name.includes("\\")) return "Le nom ne peut pas contenir de barre oblique.";
  if (name === "." || name === "..") return "Ce nom n'est pas permis.";
  return null;
}

export type PickedFile = { file: File; path: string };

/** Fichiers d'un glisser-déposer, dossiers compris (parcours récursif quand le navigateur le permet). */
export async function filesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const entries = Array.from(dt.items)
    .filter((i) => i.kind === "file")
    .map((i) => (typeof i.webkitGetAsEntry === "function" ? i.webkitGetAsEntry() : null));
  if (entries.length && entries.every((e) => e !== null)) {
    const out: PickedFile[] = [];
    for (const entry of entries) await walk(entry!, "", out);
    return out;
  }
  return Array.from(dt.files).map((file) => ({ file, path: file.name }));
}

async function walk(entry: FileSystemEntry, base: string, out: PickedFile[]): Promise<void> {
  const path = base ? `${base}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ file, path });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries rend les éléments par lots : on relit jusqu'au lot vide.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    for (const child of batch) await walk(child, path, out);
  }
}

export type ExcludedFile = { path: string; size: number; reason: string };

/** Groupe d'écartés de même raison (ex. « Dossier node_modules refusé… », 17 107 fichiers). */
export type ExcludedGroup = { reason: string; count: number; bytes: number; examples: string[] };

/** Dossier de projet reconnu : package.json à la racine et un dossier de sortie avec index.html. */
export type ProjectHint = { root: string; output: string; files: PickedFile[]; bytes: number };

export type PreparedSelection = {
  /** À envoyer : ni dossier de développement, ni chemin interdit, ni fichier au-delà de la limite. */
  send: PickedFile[];
  excluded: ExcludedFile[];
  groups: ExcludedGroup[];
  project: ProjectHint | null;
};

const OUTPUT_DIRS = ["dist", "build", "out"];

/**
 * Tri avant l'envoi, avec les règles du serveur (@hub/site-paths, une seule source) : les dossiers de
 * développement et les fichiers interdits ne partent jamais ; les fichiers trop lourds sont nommés.
 */
export function prepareSelection(picked: PickedFile[], maxFileBytes: number | null, rules: ClassifyOptions = {}): PreparedSelection {
  const send: PickedFile[] = [];
  const excluded: ExcludedFile[] = [];
  for (const p of picked) {
    const { verdict } = checkSitePath(p.path, rules);
    if (verdict.action !== "accept") excluded.push({ path: p.path, size: p.file.size, reason: verdict.reason });
    else if (maxFileBytes != null && p.file.size > maxFileBytes) excluded.push({ path: p.path, size: p.file.size, reason: fileTooBigReason(p.file.size, rules.hosting) });
    else send.push(p);
  }
  const byReason = new Map<string, ExcludedGroup>();
  for (const e of excluded) {
    // Fichiers trop lourds : un groupe par fichier (nom et taille toujours visibles).
    const key = e.reason.startsWith("Fichier de ") ? `${e.reason}|${e.path}` : e.reason;
    const g = byReason.get(key) ?? { reason: e.reason, count: 0, bytes: 0, examples: [] };
    g.count++;
    g.bytes += e.size;
    if (g.examples.length < 3) g.examples.push(e.path);
    byReason.set(key, g);
  }
  const groups = [...byReason.values()].sort((a, b) => b.count - a.count);
  // Projet reconnu sur toute la sélection : package.json est écarté de l'envoi, mais il signe le projet.
  return { send, excluded, groups, project: detectProject(picked, send) };
}

function detectProject(all: PickedFile[], files: PickedFile[]): ProjectHint | null {
  const paths = new Set(all.map((f) => f.path));
  const tops = new Set(all.map((f) => (f.path.includes("/") ? f.path.split("/")[0]! : "")));
  // Un seul dossier racine (dossier choisi ou glissé) ou les fichiers du projet à plat.
  const root = tops.size === 1 && !tops.has("") ? [...tops][0]! : paths.has("package.json") ? "" : null;
  if (root === null) return null;
  const prefix = root ? `${root}/` : "";
  if (!paths.has(`${prefix}package.json`)) return null;
  for (const out of OUTPUT_DIRS) {
    if (!paths.has(`${prefix}${out}/index.html`)) continue;
    const base = `${prefix}${out}/`;
    const inside = files.filter((f) => f.path.startsWith(base)).map((f) => ({ file: f.file, path: f.path.slice(base.length) }));
    return { root, output: out, files: inside, bytes: inside.reduce((n, f) => n + f.file.size, 0) };
  }
  return null;
}

/**
 * Dossier unique en tête de tous les chemins (dossier choisi ou glissé) : retiré pour que son contenu soit le
 * site, comme le dossier racine unique d'un zip. root null : fichiers à plat ou plusieurs dossiers.
 */
export function stripSingleRoot(files: PickedFile[]): { files: PickedFile[]; root: string | null } {
  const tops = new Set(files.map((f) => (f.path.includes("/") ? f.path.split("/")[0]! : "")));
  if (files.length === 0 || tops.size !== 1 || tops.has("")) return { files, root: null };
  const root = [...tops][0]!;
  return { files: files.map((f) => ({ file: f.file, path: f.path.slice(root.length + 1) })), root };
}

/** Fichiers d'un champ « fichier » : chemin relatif gardé pour un envoi de dossier (webkitdirectory). */
export function filesFromInput(list: FileList | null): PickedFile[] {
  return Array.from(list ?? []).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

/** Navigateur capable de choisir un dossier (bureau) ; masqué au doigt, où ce choix n'est pas fiable. */
export function canPickFolder(): boolean {
  if (typeof document === "undefined") return false;
  const finePointer = window.matchMedia?.("(pointer: fine)").matches ?? false;
  return finePointer && "webkitdirectory" in document.createElement("input");
}

export function finePointer(): boolean {
  return typeof window !== "undefined" && (window.matchMedia?.("(pointer: fine)").matches ?? false);
}
