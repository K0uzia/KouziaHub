import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// TOTP (RFC 6238) sur HOTP (RFC 4226) : quelques lignes avec node:crypto, sans dépendance.

export const TOTP_PERIOD_S = 30;
export const TOTP_DIGITS = 6;
/** Pas acceptés autour du pas courant (décalage d'horloge du téléphone). */
export const TOTP_WINDOW = 1;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error("Clé base32 invalide");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Secret de 160 bits (taille recommandée pour HMAC-SHA1), en base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(bin).padStart(digits, "0");
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_S);
}

/**
 * Pas TOTP correspondant au code, dans la fenêtre ±TOTP_WINDOW, sinon null.
 * L'appelant refuse un pas déjà utilisé (anti-rejeu).
 */
export function matchTotpStep(secretBase32: string, code: string, nowMs = Date.now()): number | null {
  const given = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(given)) return null;
  const secret = base32Decode(secretBase32);
  const current = totpStep(nowMs);
  let matched: number | null = null;
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    const expected = hotp(secret, current + d);
    // Toujours les 3 comparaisons : la durée ne dit pas quel pas correspond.
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(given)) && matched === null) {
      matched = current + d;
    }
  }
  return matched;
}

/** URI lue par Google Authenticator (QR code ou saisie). */
export function otpauthUri(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_S),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
