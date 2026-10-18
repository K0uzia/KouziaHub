import { generateKeyPairSync } from "node:crypto";

/**
 * Clés VAPID au format standard (celui de web-push generate-vapid-keys) : clé publique brute
 * (0x04 + x + y, 65 octets) et clé privée brute (d, 32 octets), en base64url. Repris de l'ERP.
 */
export type VapidConfig = { publicKey: string; privateKey: string; subject: string };

const b64url = (buf: Buffer) => buf.toString("base64url");

export function vapidStatus(env: NodeJS.ProcessEnv = process.env): { config: VapidConfig | null; reason: string | null } {
  const pub = env.VAPID_PUBLIC_KEY?.trim();
  const priv = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  if (!pub || !priv) return { config: null, reason: "clés VAPID absentes (hubctl push-keys)" };
  if (!subject || !/^(mailto:|https:\/\/)/.test(subject)) {
    return { config: null, reason: "VAPID_SUBJECT absent ou invalide (mailto:… ou https://…)" };
  }
  const raw = Buffer.from(pub, "base64url");
  const d = Buffer.from(priv, "base64url");
  if (raw.length !== 65 || raw[0] !== 0x04 || d.length !== 32) {
    return { config: null, reason: "clés VAPID invalides (format web-push attendu)" };
  }
  return { config: { publicKey: pub, privateKey: priv, subject }, reason: null };
}

/** Nouvelle paire de clés (hubctl push-keys). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x!, "base64url");
  const y = Buffer.from(jwk.y!, "base64url");
  return {
    publicKey: b64url(Buffer.concat([Buffer.from([0x04]), x, y])),
    privateKey: jwk.d!,
  };
}
