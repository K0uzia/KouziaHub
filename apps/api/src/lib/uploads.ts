import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, statfs, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CreateUploadInput, RejectedFile, UploadFileDecl, UploadSession } from "@/contract.js";
import type { FileRef } from "@/lib/files.js";
import { HttpError } from "@/lib/http.js";
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_SITE_BYTES,
  MAX_UPLOAD_PENDING_BYTES,
  MAX_UPLOAD_SESSIONS,
  MAX_UPLOAD_SESSIONS_PER_SITE,
  MAX_UPLOAD_ZIP_BYTES,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_DISK_MARGIN_BYTES,
  UPLOAD_SESSION_TTL_MS,
} from "@/lib/limits.js";
import type { BlobStore } from "@/lib/blobs.js";
import { checkSitePath, fileTooBigReason, normalizeDir } from "@/lib/site-paths.js";

const MIB = 1024 * 1024;
const SHA = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{24}$/;

/**
 * Sessions occupées (morceau en écriture, assemblage, import du résultat), partagées par toutes les
 * instances d'UploadStore du processus : la purge du cache du hub ne supprime jamais une session occupée.
 */
const sessionLocks = new Map<string, Promise<unknown>>();
const busySessions = new Map<string, number>();

export function isUploadSessionBusy(id: string): boolean {
  return sessionLocks.has(id) || busySessions.has(id);
}

/** Marque une session occupée pendant fn (finalisation : assemblage puis import). */
export async function withUploadSessionBusy<T>(id: string, fn: () => Promise<T>): Promise<T> {
  busySessions.set(id, (busySessions.get(id) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    const n = (busySessions.get(id) ?? 1) - 1;
    if (n <= 0) busySessions.delete(id);
    else busySessions.set(id, n);
  }
}

type Meta = UploadSession & { siteId: string; chunkHashes: Record<string, string> };

/** Octets libres pour un utilisateur ordinaire sur le volume de `dir` (fs.statfs). */
export async function diskFreeBytes(dir: string): Promise<number> {
  const info = await statfs(dir);
  return Number(info.bavail) * Number(info.bsize);
}

function mib(bytes: number): string {
  return `${(bytes / MIB).toFixed(1).replace(".", ",")} Mio`;
}

function publicView(meta: Meta): UploadSession {
  const { siteId: _siteId, chunkHashes: _hashes, ...rest } = meta;
  return { ...rest, received: [...rest.received].sort((a, b) => a - b) };
}

/**
 * Sessions d'envoi par morceaux, sur le disque (HUB_DATA_DIR/uploads/<id>/) : session.json et un fichier par
 * morceau reçu. Expirées au bout de 24 h, nettoyées à chaque ouverture et à intervalle régulier.
 */
export class UploadStore {
  readonly dir: string;

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
    /** Place libre du volume (remplaçable dans les tests). */
    private readonly freeBytes: (dir: string) => Promise<number> = diskFreeBytes,
  ) {
    this.dir = path.join(dataDir, "uploads");
  }

  /** Refus clair si écrire `bytes` laisserait moins que la réserve sur le disque du hub. */
  private async ensureDiskSpace(bytes: number): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const free = await this.freeBytes(this.dir);
    if (free - bytes < UPLOAD_DISK_MARGIN_BYTES) {
      throw new HttpError(
        507,
        `Place disque insuffisante sur le hub : il reste ${mib(free)}, il faut ${mib(bytes)} plus une réserve de ${mib(UPLOAD_DISK_MARGIN_BYTES)}. Libérez de la place (anciennes versions, sauvegardes) puis réessayez.`,
        "disk_full",
      );
    }
  }

  /** Sessions ouvertes non expirées, tous sites confondus. */
  private async openMetas(): Promise<Meta[]> {
    const ids = await readdir(this.dir).catch(() => [] as string[]);
    const out: Meta[] = [];
    for (const id of ids) {
      if (!ID.test(id)) continue;
      try {
        const meta = JSON.parse(await readFile(path.join(this.dir, id, "session.json"), "utf8")) as Meta;
        if (Date.parse(meta.expiresAt) > this.now()) out.push(meta);
      } catch {
        /* illisible : nettoyé par sweep() */
      }
    }
    return out;
  }

  private sessionDir(id: string): string {
    if (!ID.test(id)) throw new HttpError(404, "Session d'envoi introuvable.", "upload_not_found");
    return path.join(this.dir, id);
  }

  /** Écritures d'une même session l'une après l'autre (morceaux envoyés en parallèle). */
  private async locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = sessionLocks.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    sessionLocks.set(id, run);
    try {
      return await run;
    } finally {
      if (sessionLocks.get(id) === run) sessionLocks.delete(id);
    }
  }

  private async readMeta(siteId: string, id: string): Promise<Meta> {
    let meta: Meta;
    try {
      meta = JSON.parse(await readFile(path.join(this.sessionDir(id), "session.json"), "utf8")) as Meta;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(404, "Session d'envoi introuvable : elle a peut-être expiré ou été annulée. Relancez l'envoi.", "upload_not_found");
    }
    if (meta.siteId !== siteId) throw new HttpError(404, "Session d'envoi introuvable.", "upload_not_found");
    if (Date.parse(meta.expiresAt) <= this.now()) {
      await rm(this.sessionDir(id), { recursive: true, force: true });
      throw new HttpError(404, "Session d'envoi expirée (24 h) : relancez l'envoi.", "upload_expired");
    }
    return meta;
  }

  private async writeMeta(meta: Meta): Promise<void> {
    const file = path.join(this.sessionDir(meta.id), "session.json");
    const tmp = `${file}.${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, JSON.stringify(meta));
    await rename(tmp, file);
  }

  async create(siteId: string, input: CreateUploadInput): Promise<UploadSession> {
    await this.sweep();
    const id = randomBytes(12).toString("hex");
    const now = this.now();
    let files: UploadFileDecl[] = [];
    let included: number[] = [];
    const rejected: RejectedFile[] = [];
    let totalBytes = 0;
    let dir: string | null = null;
    let mode: "replace" | "merge" | null = null;

    if (input.kind === "files") {
      if (input.files.length > MAX_FILES) throw new HttpError(413, `Trop de fichiers : ${MAX_FILES} au plus par site.`, "too_many_files");
      const parsedDir = normalizeDir(input.dir ?? "");
      if (!parsedDir.ok) throw new HttpError(400, `Dossier cible invalide : ${parsedDir.reason}`);
      dir = parsedDir.path;
      mode = input.mode ?? "merge";
      if (mode !== "replace" && mode !== "merge") throw new HttpError(400, "Mode attendu : replace ou merge.");
      // Remplacer tout le contenu : seulement pour le site entier, envoyé à la racine.
      if (mode === "replace" && dir !== "") throw new HttpError(400, "« Remplacer tout le contenu » s'applique à la racine du site seulement.");
      const seen = new Set<string>();
      input.files.forEach((f, index) => {
        if (!SHA.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size < 0) {
          throw new HttpError(400, `Description invalide pour « ${String(f.path).slice(0, 200)} » (taille ou empreinte).`);
        }
        const { path: target, verdict } = checkSitePath(dir ? `${dir}/${f.path}` : f.path);
        if (verdict.action !== "accept") {
          rejected.push({ path: target || "(sans nom)", reason: verdict.reason });
          return;
        }
        if (f.size > MAX_FILE_BYTES) {
          rejected.push({ path: target, reason: fileTooBigReason(f.size) });
          return;
        }
        const key = target.toLowerCase();
        if (seen.has(key)) {
          rejected.push({ path: target, reason: "Fichier en double dans l'envoi (même nom, à la casse près)." });
          return;
        }
        seen.add(key);
        files.push({ path: target, size: f.size, sha256: f.sha256 });
        included.push(index);
        totalBytes += f.size;
      });
      if (totalBytes > MAX_SITE_BYTES) {
        throw new HttpError(413, `Envoi de ${mib(totalBytes)} : un site fait ${MAX_SITE_BYTES / MIB} Mio au plus.`, "site_too_large");
      }
    } else {
      if (!SHA.test(input.sha256) || !Number.isSafeInteger(input.size) || input.size <= 0) throw new HttpError(400, "Zip invalide (taille ou empreinte).");
      if (input.mode !== "replace" && input.mode !== "merge") throw new HttpError(400, "Mode attendu : replace ou merge.");
      if (input.size > MAX_UPLOAD_ZIP_BYTES) {
        throw new HttpError(413, `Zip de ${mib(input.size)} : ${MAX_UPLOAD_ZIP_BYTES / MIB} Mio au plus.`, "zip_too_large");
      }
      mode = input.mode;
      files = [{ path: String(input.name ?? "site.zip").slice(0, 255), size: input.size, sha256: input.sha256 }];
      included = [0];
      totalBytes = input.size;
    }

    // Plafonds : sessions ouvertes (par site, au total), octets en attente, place libre sur le disque.
    const open = await this.openMetas();
    if (open.filter((m) => m.siteId === siteId).length >= MAX_UPLOAD_SESSIONS_PER_SITE || open.length >= MAX_UPLOAD_SESSIONS) {
      throw new HttpError(
        409,
        `Trop d'envois en cours : ${MAX_UPLOAD_SESSIONS_PER_SITE} au plus par site et ${MAX_UPLOAD_SESSIONS} au total. Reprenez ou annulez un envoi interrompu.`,
        "too_many_uploads",
      );
    }
    const pending = open.reduce((n, m) => n + m.totalBytes, 0);
    if (pending + totalBytes > MAX_UPLOAD_PENDING_BYTES) {
      throw new HttpError(
        413,
        `Envois en attente trop lourds : ${mib(pending)} déjà réservés, ${mib(MAX_UPLOAD_PENDING_BYTES)} au plus. Terminez ou annulez un envoi interrompu.`,
        "upload_quota",
      );
    }
    await this.ensureDiskSpace(totalBytes);

    const meta: Meta = {
      id,
      siteId,
      kind: input.kind,
      dir,
      mode,
      files,
      included,
      rejected,
      chunkSize: UPLOAD_CHUNK_BYTES,
      totalBytes,
      chunkCount: Math.ceil(totalBytes / UPLOAD_CHUNK_BYTES),
      received: [],
      chunkHashes: {},
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + UPLOAD_SESSION_TTL_MS).toISOString(),
    };
    await mkdir(path.join(this.sessionDir(id), "chunks"), { recursive: true });
    await this.writeMeta(meta);
    return publicView(meta);
  }

  async get(siteId: string, id: string): Promise<UploadSession> {
    return publicView(await this.readMeta(siteId, id));
  }

  async list(siteId: string): Promise<UploadSession[]> {
    await this.sweep();
    const ids = await readdir(this.dir).catch(() => [] as string[]);
    const out: UploadSession[] = [];
    for (const id of ids) {
      if (!ID.test(id)) continue;
      try {
        out.push(await this.get(siteId, id));
      } catch {
        /* autre site, expirée ou illisible */
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async putChunk(siteId: string, id: string, index: number, data: Buffer, declaredSha: string | undefined): Promise<UploadSession> {
    return this.locked(id, async () => {
      const meta = await this.readMeta(siteId, id);
      if (!Number.isInteger(index) || index < 0 || index >= meta.chunkCount) {
        throw new HttpError(400, `Morceau ${index} hors de la session (0 à ${meta.chunkCount - 1}).`, "chunk_out_of_range");
      }
      const expected = Math.min(meta.chunkSize, meta.totalBytes - index * meta.chunkSize);
      if (data.length !== expected) {
        throw new HttpError(400, `Morceau ${index} de ${data.length} octets, ${expected} attendus.`, "chunk_size_mismatch");
      }
      const sha = createHash("sha256").update(data).digest("hex");
      if (!declaredSha || declaredSha.toLowerCase() !== sha) {
        throw new HttpError(400, `Morceau ${index} abîmé en route (empreinte différente) : il sera renvoyé.`, "chunk_hash_mismatch");
      }
      // Morceau déjà reçu, identique : rien à faire (reprise après une coupure, envoi en double).
      if (meta.chunkHashes[String(index)] === sha) return publicView(meta);
      await this.ensureDiskSpace(data.length);
      await writeFile(path.join(this.sessionDir(id), "chunks", String(index)), data);
      meta.chunkHashes[String(index)] = sha;
      if (!meta.received.includes(index)) meta.received.push(index);
      await this.writeMeta(meta);
      return publicView(meta);
    });
  }

  async cancel(siteId: string, id: string): Promise<void> {
    await this.readMeta(siteId, id);
    await rm(this.sessionDir(id), { recursive: true, force: true });
  }

  /**
   * Reconstitue le flux et vérifie chaque empreinte avant toute écriture dans la version de travail.
   * Fichiers : écrits dans le magasin de blobs (rien n'est référencé avant importFiles). Zip : fichier temporaire.
   */
  async assemble(
    siteId: string,
    id: string,
    blobs: BlobStore,
  ): Promise<{ session: UploadSession; stored: FileRef[]; zipPath: string | null; done: () => Promise<void> }> {
    return this.locked(id, async () => {
      const meta = await this.readMeta(siteId, id);
      const missing: number[] = [];
      for (let i = 0; i < meta.chunkCount; i++) if (!meta.received.includes(i)) missing.push(i);
      if (missing.length) {
        throw new HttpError(409, `Envoi incomplet : ${missing.length} morceau(x) manquant(s). Reprenez l'envoi.`, "upload_incomplete");
      }
      const dir = this.sessionDir(id);
      const done = () => rm(dir, { recursive: true, force: true });
      const reader = new ChunkReader(path.join(dir, "chunks"));

      if (meta.kind === "zip") {
        const zipPath = path.join(dir, "site.zip");
        const out = createWriteStream(zipPath);
        const hash = createHash("sha256");
        try {
          for (let i = 0; i < meta.chunkCount; i++) {
            const chunk = path.join(dir, "chunks", String(i));
            const buf = await readFile(chunk);
            hash.update(buf);
            if (!out.write(buf)) await new Promise((r) => out.once("drain", r));
            // Morceau copié : supprimé tout de suite, le zip ne prend pas deux fois sa place.
            await unlink(chunk);
          }
          await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
        } catch (err) {
          out.destroy();
          await done();
          throw err;
        }
        if (hash.digest("hex") !== meta.files[0]!.sha256) {
          throw new HttpError(400, "Le zip reçu ne correspond pas à celui annoncé (empreinte différente) : relancez l'envoi.", "file_hash_mismatch");
        }
        return { session: publicView(meta), stored: [], zipPath, done };
      }

      // Vérification de tous les fichiers d'abord : tout ou rien.
      const bad: string[] = [];
      for (const f of meta.files) {
        const sha = createHash("sha256").update(await reader.read(f.size)).digest("hex");
        if (sha !== f.sha256) bad.push(f.path);
      }
      if (bad.length) {
        throw new HttpError(
          400,
          `Contenu différent de l'annonce pour ${bad.length} fichier(s), dont « ${bad[0]} » : le fichier a peut-être changé pendant l'envoi. Relancez l'envoi.`,
          "file_hash_mismatch",
        );
      }
      const stored: FileRef[] = [];
      // Copie dans le magasin de blobs : chaque morceau est supprimé dès qu'il est entièrement lu.
      const consumer = new ChunkReader(path.join(dir, "chunks"), true);
      try {
        for (const f of meta.files) {
          const blob = await blobs.putBuffer(await consumer.read(f.size));
          stored.push({ path: f.path, sha256: blob.sha256, size: blob.size });
        }
        await consumer.finish();
      } catch (err) {
        // Morceaux en partie supprimés : la session ne peut plus servir.
        await done();
        throw err;
      }
      return { session: publicView(meta), stored, zipPath: null, done };
    });
  }

  /** Supprime les sessions expirées (et les dossiers illisibles plus vieux que la durée de vie). */
  async sweep(): Promise<number> {
    const ids = await readdir(this.dir).catch(() => [] as string[]);
    let removed = 0;
    for (const id of ids) {
      const dir = path.join(this.dir, id);
      let expired = false;
      try {
        const meta = JSON.parse(await readFile(path.join(dir, "session.json"), "utf8")) as Meta;
        expired = Date.parse(meta.expiresAt) <= this.now();
      } catch {
        const info = await stat(dir).catch(() => null);
        expired = !info || info.mtimeMs + UPLOAD_SESSION_TTL_MS <= this.now();
      }
      if (expired) {
        await rm(dir, { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }
}

/** Lecture séquentielle du flux formé par les morceaux, par tranches de taille donnée. */
class ChunkReader {
  private index = 0;
  private offset = 0;
  private current: Buffer | null = null;

  constructor(
    private readonly dir: string,
    /** Supprime chaque morceau dès qu'il est entièrement lu. */
    private readonly consume = false,
  ) {}

  /** Fin de lecture : dernier morceau supprimé (mode consommation). */
  async finish(): Promise<void> {
    if (this.consume && this.current) await unlink(path.join(this.dir, String(this.index - 1))).catch(() => undefined);
    this.current = null;
  }

  async read(size: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let need = size;
    while (need > 0) {
      if (!this.current || this.offset >= this.current.length) {
        if (this.consume && this.current) await unlink(path.join(this.dir, String(this.index - 1)));
        this.current = await readFile(path.join(this.dir, String(this.index)));
        this.index++;
        this.offset = 0;
      }
      const take = Math.min(need, this.current.length - this.offset);
      parts.push(this.current.subarray(this.offset, this.offset + take));
      this.offset += take;
      need -= take;
    }
    return Buffer.concat(parts, size);
  }
}
