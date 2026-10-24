import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { createGzip } from "node:zlib";

// Archive tar.gz d'une version, envoyée à l'agent du CT des sites PHP (docs/cadrage.md, section 11.5). Fichiers
// réguliers seulement, en ustar ; un nom de plus de 100 octets passe par l'en-tête GNU « L » (nom long), que lit
// le tar de BusyBox. Écrite sur le disque en calculant son empreinte, annoncée et signée à l'envoi.

export type TarEntry = { path: string; size: number; read: () => Promise<Buffer> };

const BLOCK = 512;

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function header(name: string, size: number, type: "0" | "L", mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, Math.min(Buffer.byteLength(name), 100), "utf8");
  h.write(octal(type === "L" ? 0o644 : 0o644, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(size, 12), 124, "ascii");
  h.write(octal(mtime, 12), 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write(type, 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return h;
}

const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK, 0);

/** Écrit l'archive tar.gz dans outFile ; renvoie son empreinte SHA-256 (hex) et sa taille. */
export async function writeTarGz(entries: TarEntry[], outFile: string, mtime = Math.floor(Date.now() / 1000)): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const gzip = createGzip();
  const out = createWriteStream(outFile, { mode: 0o600 });
  gzip.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  gzip.pipe(out);
  const write = async (buf: Buffer) => {
    if (!gzip.write(buf)) await once(gzip, "drain");
  };
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    if (name.length > 100) {
      // Nom long (GNU) : un pseudo-fichier « ././@LongLink » porte le nom complet, terminé par un zéro.
      const long = Buffer.concat([name, Buffer.from([0])]);
      await write(header("././@LongLink", long.length, "L", mtime));
      await write(long);
      await write(padding(long.length));
    }
    const data = await entry.read();
    if (data.length !== entry.size) throw new Error(`Taille inattendue pour ${entry.path}.`);
    await write(header(entry.path, data.length, "0", mtime));
    await write(data);
    await write(padding(data.length));
  }
  await write(Buffer.alloc(BLOCK * 2, 0));
  gzip.end();
  await once(out, "finish");
  return { sha256: hash.digest("hex"), bytes };
}
