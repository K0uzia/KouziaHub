import path from "node:path";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * Empreinte d'un fichier pour l'envoi direct Pages, calculée comme wrangler (hashFile) : blake3 du
 * contenu en base64 suivi de l'extension sans le point (casse conservée, comme path.extname), en
 * hexadécimal tronqué à 32 caractères.
 */
export function pagesAssetHash(content: Buffer, filePath: string): string {
  const input = content.toString("base64") + path.posix.extname(filePath).slice(1);
  return bytesToHex(blake3(new TextEncoder().encode(input))).slice(0, 32);
}
