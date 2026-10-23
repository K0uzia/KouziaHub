import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Une paire Ed25519 par logiciel (docs/licences-logiciels.md, section 4) : <slug>-ed25519.pem dans LICENSE_KEY_DIR
// (root:kouziahub, 640), créée par « hubctl licence-keygen <slug> », jamais par l'interface. Tracebay garde son chemin
// historique TRACEBAY_LICENSE_KEY_FILE ; sans LICENSE_KEY_DIR, le dossier de ce fichier sert pour les autres.
// Jamais journalisée, ni la clé ni le nom du fichier. Absente ou illisible : la liste reste lisible, l'émission répond 503.

const cached = new Map<string, KeyObject>();

/** Chemin du fichier de clé privée d'un logiciel, null si aucun dossier n'est configuré. */
export function keyFileOf(slug: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const tracebay = env.TRACEBAY_LICENSE_KEY_FILE?.trim();
  if (slug === "tracebay" && tracebay) return tracebay;
  const dir = env.LICENSE_KEY_DIR?.trim() || (tracebay ? path.dirname(tracebay) : "");
  return dir ? path.join(dir, `${slug}-ed25519.pem`) : null;
}

export async function signingKey(slug: string): Promise<KeyObject | null> {
  const file = keyFileOf(slug);
  if (!file) return null;
  const hit = cached.get(file);
  if (hit) return hit;
  try {
    const key = createPrivateKey(await readFile(file, "utf8"));
    if (key.asymmetricKeyType !== "ed25519") return null;
    cached.set(file, key);
    return key;
  } catch {
    return null;
  }
}

/** Clé publique SPKI PEM, à embarquer dans le logiciel (publique, sans secret). */
export function publicPemOf(key: KeyObject): string {
  return createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
}

/** Tests : oublie les clés gardées en mémoire. */
export function forgetSigningKey(): void {
  cached.clear();
}
