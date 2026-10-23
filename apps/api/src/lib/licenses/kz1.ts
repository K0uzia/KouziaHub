import { sign, verify, type KeyObject } from "node:crypto";
import { isDay } from "./terms.js";

// Format générique KZ1 (docs/licences-logiciels.md, section 3.7, normatif) : même construction que TB1, avec un préfixe
// propre au logiciel et le champ signé « logiciel » (son identifiant). Un logiciel refuse une clé dont le champ
// « logiciel » n'est pas le sien : une clé d'un logiciel ne valide jamais un autre, même si les paires étaient mêlées.

export const KZ1 = "KZ1";
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** Préfixe : 2 à 8 caractères, majuscule d'abord, puis majuscules ou chiffres. TB1 est réservé à Tracebay. */
export const PREFIX_RE = /^[A-Z][A-Z0-9]{1,7}$/;
export const RESERVED_PREFIXES = ["TB1", "KZ1"] as const;

export type Kz1Payload = { v: 1; logiciel: string; id: string; entreprise: string; emise: string; expire: string };

/** JSON canonique : exactement ces clés, dans cet ordre, JSON.stringify (non ASCII laissé tel quel). */
export function canonicalKz1(p: Kz1Payload): string {
  return JSON.stringify({ v: p.v, logiciel: p.logiciel, id: p.id, entreprise: p.entreprise, emise: p.emise, expire: p.expire });
}

/** <PRÉFIXE>.<données>.<signature>, base64url sans padding ; signature Ed25519 des octets UTF-8 du JSON. */
export function signKz1(prefix: string, p: Kz1Payload, privateKey: KeyObject): string {
  const data = Buffer.from(canonicalKz1(p), "utf8");
  return `${prefix}.${data.toString("base64url")}.${sign(null, data, privateKey).toString("base64url")}`;
}

/** Vérification attendue côté logiciel : préfixe, forme, signature, puis « logiciel » égal à l'identifiant attendu. */
export function verifyKz1(
  text: string,
  expected: { prefix: string; logiciel: string },
  publicKey: KeyObject,
): { ok: true; payload: Kz1Payload } | { ok: false; reason: "format" | "signature" | "logiciel" } {
  const parts = text.trim().split(".");
  if (parts.length !== 3 || parts[0] !== expected.prefix || !/^[A-Za-z0-9_-]+$/.test(parts[1]!) || !/^[A-Za-z0-9_-]+$/.test(parts[2]!)) return { ok: false, reason: "format" };
  const data = Buffer.from(parts[1]!, "base64url");
  let payload: Kz1Payload;
  try {
    payload = JSON.parse(data.toString("utf8")) as Kz1Payload;
  } catch {
    return { ok: false, reason: "format" };
  }
  if (
    payload?.v !== 1 ||
    typeof payload.logiciel !== "string" ||
    typeof payload.id !== "string" ||
    !ID_RE.test(payload.id) ||
    typeof payload.entreprise !== "string" ||
    !isDay(payload.emise) ||
    !isDay(payload.expire) ||
    canonicalKz1(payload) !== data.toString("utf8")
  ) {
    return { ok: false, reason: "format" };
  }
  if (!verify(null, data, publicKey, Buffer.from(parts[2]!, "base64url"))) return { ok: false, reason: "signature" };
  return payload.logiciel === expected.logiciel ? { ok: true, payload } : { ok: false, reason: "logiciel" };
}
