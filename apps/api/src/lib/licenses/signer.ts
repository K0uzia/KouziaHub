import { createPrivateKey, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";

// Clé privée Ed25519 de Tracebay (docs/licences-logiciels.md, section 4) : fichier hors dépôt et hors .env, chemin dans
// TRACEBAY_LICENSE_KEY_FILE (root:kouziahub, 640). Jamais journalisée, ni la clé ni le nom du fichier. Absente ou
// illisible : la liste reste lisible, l'émission répond 503.

let cached: { path: string; key: KeyObject } | null = null;

export async function signingKey(path = process.env.TRACEBAY_LICENSE_KEY_FILE?.trim()): Promise<KeyObject | null> {
  if (!path) return null;
  if (cached?.path === path) return cached.key;
  try {
    const key = createPrivateKey(await readFile(path, "utf8"));
    if (key.asymmetricKeyType !== "ed25519") return null;
    cached = { path, key };
    return key;
  } catch {
    return null;
  }
}

/** Tests : oublie la clé gardée en mémoire. */
export function forgetSigningKey(): void {
  cached = null;
}
