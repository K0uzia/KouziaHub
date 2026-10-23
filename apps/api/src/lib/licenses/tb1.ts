import { sign, verify, type KeyObject } from "node:crypto";
import { parisDayKey } from "@/lib/fr-format.js";
import { isDay } from "./terms.js";

export * from "./terms.js";

// Contrat de la clé Tracebay, format TB1 (docs/licences-logiciels.md, section 3, normatif) : les deux dépôts produisent
// et lisent les mêmes octets. Fonctions pures, node:crypto seul.

export const TB1 = "TB1";
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Jour de Paris (AAAA-MM-JJ). */
export const parisToday = (now: number = Date.now()) => parisDayKey(now);

export type Tb1Payload = { v: 1; id: string; entreprise: string; emise: string; expire: string };

/** JSON canonique : exactement ces clés, dans cet ordre, JSON.stringify (non ASCII laissé tel quel). */
export function canonicalJson(p: Tb1Payload): string {
  return JSON.stringify({ v: p.v, id: p.id, entreprise: p.entreprise, emise: p.emise, expire: p.expire });
}

/** TB1.<données>.<signature>, base64url sans padding ; signature Ed25519 des octets UTF-8 du JSON. */
export function signTb1(p: Tb1Payload, privateKey: KeyObject): string {
  const data = Buffer.from(canonicalJson(p), "utf8");
  return `${TB1}.${data.toString("base64url")}.${sign(null, data, privateKey).toString("base64url")}`;
}

/** Vérification (même contrat que Tracebay) : motif renvoyé à l'interface seulement, jamais à un tiers. */
export function verifyTb1(text: string, publicKey: KeyObject): { ok: true; payload: Tb1Payload } | { ok: false; reason: "format" | "signature" } {
  const parts = text.trim().split(".");
  if (parts.length !== 3 || parts[0] !== TB1 || !/^[A-Za-z0-9_-]+$/.test(parts[1]!) || !/^[A-Za-z0-9_-]+$/.test(parts[2]!)) return { ok: false, reason: "format" };
  const data = Buffer.from(parts[1]!, "base64url");
  let payload: Tb1Payload;
  try {
    payload = JSON.parse(data.toString("utf8")) as Tb1Payload;
  } catch {
    return { ok: false, reason: "format" };
  }
  if (
    payload?.v !== 1 ||
    typeof payload.id !== "string" ||
    !ID_RE.test(payload.id) ||
    typeof payload.entreprise !== "string" ||
    !isDay(payload.emise) ||
    !isDay(payload.expire) ||
    canonicalJson(payload) !== data.toString("utf8")
  ) {
    return { ok: false, reason: "format" };
  }
  return verify(null, data, publicKey, Buffer.from(parts[2]!, "base64url")) ? { ok: true, payload } : { ok: false, reason: "signature" };
}
