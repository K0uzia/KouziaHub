import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { prisma } from "@/lib/prisma.js";

export type StoredBlob = { sha256: string; size: number };

export class BlobTooLargeError extends Error {
  constructor(readonly limit: number) {
    super("Fichier trop volumineux.");
  }
}

const SHA = /^[0-9a-f]{64}$/;

/**
 * Magasin d'objets adressé par contenu : <dir>/<2 premiers>/<sha256>. Partagé entre fichiers de travail
 * et versions ; un blob n'est jamais réécrit, il est libéré par gc() quand plus aucune ligne n'y renvoie.
 */
export class BlobStore {
  readonly dir: string;
  private readonly tmpDir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "blobs");
    this.tmpDir = path.join(this.dir, "tmp");
  }

  pathOf(sha256: string): string {
    if (!SHA.test(sha256)) throw new Error("Empreinte invalide");
    return path.join(this.dir, sha256.slice(0, 2), sha256);
  }

  async has(sha256: string): Promise<boolean> {
    return stat(this.pathOf(sha256)).then(
      () => true,
      () => false,
    );
  }

  /**
   * Blob déjà présent : mtime rafraîchi, pour que gc() (qui épargne les blobs récents) ne l'efface pas
   * entre son réemploi par un envoi et l'écriture des lignes qui le référencent.
   */
  private async touch(sha256: string): Promise<boolean> {
    const now = new Date();
    return utimes(this.pathOf(sha256), now, now).then(
      () => true,
      () => false,
    );
  }

  async putBuffer(buffer: Buffer): Promise<StoredBlob> {
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    if (!(await this.touch(sha256))) {
      await mkdir(this.tmpDir, { recursive: true });
      const tmp = path.join(this.tmpDir, randomBytes(12).toString("hex"));
      await writeFile(tmp, buffer);
      await this.commit(tmp, sha256);
    }
    this.pin(sha256);
    return { sha256, size: buffer.length };
  }

  /** Écrit un flux en comptant les octets réellement lus ; au-delà de maxBytes, rien n'est gardé. */
  async putStream(source: Readable, maxBytes: number): Promise<StoredBlob> {
    await mkdir(this.tmpDir, { recursive: true });
    const tmp = path.join(this.tmpDir, randomBytes(12).toString("hex"));
    const hash = createHash("sha256");
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > maxBytes) {
          callback(new BlobTooLargeError(maxBytes));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(source, counter, createWriteStream(tmp));
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    const sha256 = hash.digest("hex");
    this.pin(sha256);
    await this.commit(tmp, sha256);
    return { sha256, size };
  }

  private async commit(tmp: string, sha256: string): Promise<void> {
    const target = this.pathOf(sha256);
    if (await this.touch(sha256)) {
      await unlink(tmp).catch(() => undefined);
      return;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await rename(tmp, target);
  }

  read(sha256: string): Promise<Buffer> {
    return readFile(this.pathOf(sha256));
  }

  stream(sha256: string): ReadStream {
    return createReadStream(this.pathOf(sha256));
  }

  /**
   * Supprime les blobs qu'aucune ligne WorkingFile ou VersionFile ne référence. Un blob plus récent que
   * graceMs est gardé : il peut appartenir à un envoi dont les lignes ne sont pas encore écrites.
   */
  /**
   * Blob réemployé ou écrit depuis moins de ce délai : jamais libéré par une purge ciblée ni par la purge
   * du cache (un envoi peut l'avoir rangé sans avoir encore écrit ses lignes). Filet en plus des épingles.
   */
  recentGraceMs = 10 * 60_000;

  /** Empreintes rangées par un envoi en cours, dont les lignes ne sont pas encore écrites : jamais purgées. */
  private readonly pins = new Map<string, number>();
  private readonly pinScope = new AsyncLocalStorage<Set<string>>();

  /**
   * Exécute un envoi (fichiers, zip, envoi par morceaux) en épinglant chaque blob qu'il range, jusqu'à la fin :
   * les purges (orphelins, purge ciblée) ne peuvent pas effacer un blob dont la ligne va être écrite.
   */
  async withPins<T>(fn: () => Promise<T>): Promise<T> {
    const held = new Set<string>();
    try {
      return await this.pinScope.run(held, fn);
    } finally {
      for (const sha of held) {
        const n = (this.pins.get(sha) ?? 1) - 1;
        if (n <= 0) this.pins.delete(sha);
        else this.pins.set(sha, n);
      }
    }
  }

  private pin(sha256: string): void {
    const held = this.pinScope.getStore();
    if (!held || held.has(sha256)) return;
    held.add(sha256);
    this.pins.set(sha256, (this.pins.get(sha256) ?? 0) + 1);
  }

  isPinned(sha256: string): boolean {
    return this.pins.has(sha256);
  }

  private async usedHashes(): Promise<Set<string>> {
    const [working, versions] = await Promise.all([
      prisma.workingFile.findMany({ select: { sha256: true }, distinct: ["sha256"] }),
      prisma.versionFile.findMany({ select: { sha256: true }, distinct: ["sha256"] }),
    ]);
    return new Set([...working, ...versions].map((r) => r.sha256));
  }

  /**
   * Parcours du magasin : taille totale et blobs orphelins (aucune ligne WorkingFile ni VersionFile).
   * Avec remove, les orphelins plus anciens que graceMs sont supprimés (et les temporaires de plus d'une heure).
   */
  async scan(options: { remove?: boolean; graceMs?: number } = {}): Promise<{ totalBytes: number; orphanCount: number; orphanBytes: number }> {
    const graceMs = options.graceMs ?? 10 * 60_000;
    const used = await this.usedHashes();
    const now = Date.now();
    const out = { totalBytes: 0, orphanCount: 0, orphanBytes: 0 };
    let prefixes: string[] = [];
    try {
      prefixes = await readdir(this.dir);
    } catch {
      return out;
    }
    for (const prefix of prefixes) {
      const folder = path.join(this.dir, prefix);
      if (prefix === "tmp") {
        if (!options.remove) continue;
        for (const name of await readdir(folder).catch(() => [] as string[])) {
          const file = path.join(folder, name);
          const info = await stat(file).catch(() => null);
          if (info && now - info.mtimeMs > Math.max(graceMs, 60 * 60_000)) await rm(file, { force: true });
        }
        continue;
      }
      if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
      for (const name of await readdir(folder).catch(() => [] as string[])) {
        if (!SHA.test(name)) continue;
        const file = path.join(folder, name);
        const info = await stat(file).catch(() => null);
        if (!info) continue;
        out.totalBytes += info.size;
        if (used.has(name) || this.pins.has(name) || (graceMs > 0 && now - info.mtimeMs < graceMs)) continue;
        if (options.remove) {
          await rm(file, { force: true });
          out.totalBytes -= info.size;
        }
        out.orphanCount++;
        out.orphanBytes += info.size;
      }
    }
    return out;
  }

  /**
   * Supprime les blobs qu'aucune ligne WorkingFile ou VersionFile ne référence. Un blob plus récent que
   * graceMs est gardé : il peut appartenir à un envoi dont les lignes ne sont pas encore écrites.
   */
  async gc(graceMs = 10 * 60_000): Promise<number> {
    return (await this.scan({ remove: true, graceMs })).orphanCount;
  }

  /** Libère ceux de ces blobs que plus rien ne référence (purge d'un site) : nombre et octets libérés. */
  async releaseUnused(hashes: Iterable<string>): Promise<{ count: number; bytes: number }> {
    const candidates = [...new Set(hashes)].filter((h) => SHA.test(h));
    if (candidates.length === 0) return { count: 0, bytes: 0 };
    const used = await this.usedHashes();
    const now = Date.now();
    let count = 0;
    let bytes = 0;
    for (const sha of candidates) {
      if (used.has(sha) || this.pins.has(sha)) continue;
      const file = this.pathOf(sha);
      const info = await stat(file).catch(() => null);
      if (!info || (this.recentGraceMs > 0 && now - info.mtimeMs < this.recentGraceMs)) continue;
      await rm(file, { force: true });
      count++;
      bytes += info.size;
    }
    return { count, bytes };
  }

}
