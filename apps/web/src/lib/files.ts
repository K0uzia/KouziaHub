import type { WorkingFileEntry } from "@hub/contract";

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

/** Fichiers par requête d'envoi (plafond du serveur : 1 000). */
export const FILES_PER_REQUEST = 1000;
/** Poids cumulé par requête : sous les 100 Mo du tunnel Cloudflare gratuit, marge pour l'enveloppe multipart. */
export const BYTES_PER_REQUEST = 90 * 1024 * 1024;

export function batchSize(batch: PickedFile[]): number {
  return batch.reduce((n, p) => n + p.file.size, 0);
}

/**
 * Découpe un envoi en requêtes (nombre de fichiers et poids cumulé) ; un fichier au-dessus du plafond
 * par fichier est écarté d'emblée, avec sa raison (il serait refusé après un envoi inutile).
 */
export function planBatches(
  picked: PickedFile[],
  maxFileBytes: number | null,
): { batches: PickedFile[][]; rejected: { path: string; reason: string }[] } {
  const batches: PickedFile[][] = [];
  const rejected: { path: string; reason: string }[] = [];
  let current: PickedFile[] = [];
  let bytes = 0;
  const cap = Math.min(maxFileBytes ?? BYTES_PER_REQUEST, BYTES_PER_REQUEST);
  for (const p of picked) {
    if (p.file.size > cap) {
      rejected.push({ path: p.path, reason: `Fichier de plus de ${Math.round(cap / (1024 * 1024))} Mo.` });
      continue;
    }
    if (current.length >= FILES_PER_REQUEST || (current.length > 0 && bytes + p.file.size > BYTES_PER_REQUEST)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(p);
    bytes += p.file.size;
  }
  if (current.length) batches.push(current);
  return { batches, rejected };
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
