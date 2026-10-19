import type { Readable } from "node:stream";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import type { RejectedFile } from "@/contract.js";
import { BlobTooLargeError, type BlobStore } from "@/lib/blobs.js";
import type { FileRef } from "@/lib/files.js";
import { HttpError } from "@/lib/http.js";
import { MAX_FILE_BYTES, MAX_FILES, MAX_SITE_BYTES } from "@/lib/limits.js";
import { classifySitePath, normalizeSitePath } from "@/lib/site-paths.js";

export type ZipLimits = { maxFiles: number; maxFileBytes: number; maxTotalBytes: number };
export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_SITE_BYTES };

export type ZipExtraction = {
  accepted: FileRef[];
  /** Fichiers refusés ou écartés, avec la raison affichable. */
  rejected: RejectedFile[];
  /** Dossier racine unique retiré (ex. « dist/ »), null sinon. */
  strippedRoot: string | null;
};

const refuse = (message: string) => new HttpError(400, `Archive refusée : ${message}`, "zip_rejected");
const printable = (name: string) => name.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 200);

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

function openZip(file: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true, decodeStrings: true }, (err, zip) =>
      err || !zip ? reject(err ?? new Error("zip")) : resolve(zip),
    );
  });
}

function readEntries(zip: ZipFile, maxEntries: number): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: Entry[] = [];
    zip.on("entry", (entry: Entry) => {
      entries.push(entry);
      if (entries.length > maxEntries) {
        reject(refuse(`plus de ${maxEntries} éléments.`));
        return;
      }
      zip.readEntry();
    });
    zip.on("end", () => resolve(entries));
    zip.on("error", (err: Error) => {
      // yauzl refuse lui-même « .. », les chemins absolus et l'antislash (strictFileNames) : archive entière refusée.
      if (/invalid relative path|absolute path|invalid characters in fileName/.test(err.message)) {
        reject(refuse(`chemin interdit dans l'archive (« .. », chemin absolu ou antislash) : ${printable(err.message.replace(/^[^:]*: /, ""))}`));
      } else {
        reject(refuse("archive illisible ou corrompue."));
      }
    });
    zip.readEntry();
  });
}

function openStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error("zip"));
      // yauzl peut émettre une seconde erreur après l'arrêt du pipeline : elle ne doit pas tuer le processus.
      stream.on("error", () => undefined);
      resolve(stream);
    });
  });
}

type Candidate = { entry: Entry; path: string };

/**
 * Lit un zip en flux et range chaque fichier accepté dans le magasin d'objets, sans toucher à la version
 * de travail : l'appelant n'écrit qu'après succès complet (tout ou rien). Les tailles comptées sont celles
 * réellement décompressées, jamais celles annoncées par l'en-tête.
 */
export async function extractZip(file: string, blobs: BlobStore, limits: ZipLimits = DEFAULT_ZIP_LIMITS, allow: readonly string[] = []): Promise<ZipExtraction> {
  let zip: ZipFile;
  try {
    zip = await openZip(file);
  } catch {
    throw refuse("fichier zip illisible ou corrompu.");
  }
  try {
    if (zip.entryCount > limits.maxFiles * 2) throw refuse(`plus de ${limits.maxFiles} fichiers.`);
    const entries = await readEntries(zip, limits.maxFiles * 2);
    const rejected: RejectedFile[] = [];
    const candidates: Candidate[] = [];

    for (const entry of entries) {
      const name = entry.fileName;
      if (name.endsWith("/")) continue;
      const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
      if ((mode & S_IFMT) === S_IFLNK) {
        rejected.push({ path: printable(name), reason: "Lien symbolique refusé." });
        continue;
      }
      if (entry.generalPurposeBitFlag & 0x1) {
        rejected.push({ path: printable(name), reason: "Fichier chiffré refusé." });
        continue;
      }
      const normalized = normalizeSitePath(name);
      if (!normalized.ok) {
        rejected.push({ path: printable(name), reason: normalized.reason });
        continue;
      }
      candidates.push({ entry, path: normalized.path });
    }

    // Dossier racine unique (ex. dist/) retiré s'il n'y a pas d'index.html à la racine.
    const meaningful = candidates.filter((c) => classifySitePath(c.path).action !== "ignore");
    let strippedRoot: string | null = null;
    if (meaningful.length > 0 && !meaningful.some((c) => c.path === "index.html")) {
      const first = meaningful[0]!.path.split("/")[0]!;
      if (meaningful.every((c) => c.path.includes("/") && c.path.split("/")[0] === first)) {
        strippedRoot = `${first}/`;
        for (const c of candidates) if (c.path.startsWith(strippedRoot)) c.path = c.path.slice(strippedRoot.length);
      }
    }

    const toRead: Candidate[] = [];
    const seen = new Map<string, string>();
    for (const c of candidates) {
      const verdict = classifySitePath(c.path, { allow });
      if (verdict.action !== "accept") {
        rejected.push({ path: c.path, reason: verdict.reason });
        continue;
      }
      const key = c.path.toLowerCase();
      const previous = seen.get(key);
      if (previous !== undefined) throw refuse(`deux fichiers portent le même nom (à la casse près) : « ${previous} » et « ${c.path} ».`);
      seen.set(key, c.path);
      if (c.entry.uncompressedSize > limits.maxFileBytes) {
        rejected.push({ path: c.path, reason: `Fichier de plus de ${Math.round(limits.maxFileBytes / 1024 / 1024)} Mio.` });
        continue;
      }
      toRead.push(c);
    }
    if (toRead.length > limits.maxFiles) throw refuse(`plus de ${limits.maxFiles} fichiers.`);

    const accepted: FileRef[] = [];
    let total = 0;
    for (const c of toRead) {
      const remaining = limits.maxTotalBytes - total;
      const cap = Math.min(limits.maxFileBytes, remaining);
      let stored;
      try {
        stored = await blobs.putStream(await openStream(zip, c.entry), cap);
      } catch (err) {
        if (err instanceof BlobTooLargeError) {
          throw refuse(
            cap < limits.maxFileBytes
              ? `taille décompressée totale au-delà de ${Math.round(limits.maxTotalBytes / 1024 / 1024)} Mio.`
              : `« ${c.path} » dépasse ${Math.round(limits.maxFileBytes / 1024 / 1024)} Mio une fois décompressé.`,
          );
        }
        throw refuse(`contenu incohérent pour « ${c.path} » (taille réelle différente de l'en-tête ou données corrompues).`);
      }
      total += stored.size;
      accepted.push({ path: c.path, sha256: stored.sha256, size: stored.size });
    }
    return { accepted, rejected, strippedRoot };
  } finally {
    zip.close();
  }
}
