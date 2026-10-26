import nodemailer, { type SendMailOptions } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { z } from "zod";
import type { SmtpSettings } from "@/contract.js";
import { decryptOptional, encrypt } from "@/lib/crypto.js";
import { HttpError } from "@/lib/http.js";
import { prisma } from "@/lib/prisma.js";

// Envoi d'e-mails du hub (docs/cadrage.md, 11.6, lot P5) : seulement pour remettre à Alexandre les e-mails capturés
// des sites PHP (bouton « Envoyer à mon adresse », option de redirection). Compte SMTP posé par lui dans les
// réglages ; mot de passe chiffré (ENCRYPTION_KEY), jamais renvoyé par l'API. Le CT PHP n'envoie jamais rien.

const KEYS = {
  host: "smtp.host",
  port: "smtp.port",
  security: "smtp.security",
  user: "smtp.user",
  password: "smtp.password",
  from: "smtp.from",
  to: "smtp.to",
} as const;

export type SmtpConfig = { host: string; port: number; security: "ssl" | "starttls"; user: string | null; password: string | null; from: string; to: string };

const EMAIL_RE = /^[^\s@<>"(),;:\\[\]]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const isEmail = (v: string) => v.length <= 254 && EMAIL_RE.test(v);

async function rows(): Promise<Record<string, string>> {
  const found = await prisma.hubSetting.findMany({ where: { key: { in: Object.values(KEYS) } } });
  return Object.fromEntries(found.map((r) => [r.key, r.value]));
}

/** Réglage complet (mot de passe déchiffré) pour l'envoi, ou null s'il manque le serveur, l'expéditeur ou l'adresse. */
export async function smtpConfig(): Promise<SmtpConfig | null> {
  const r = await rows();
  if (!r[KEYS.host] || !r[KEYS.from] || !r[KEYS.to]) return null;
  return {
    host: r[KEYS.host],
    port: Number(r[KEYS.port] ?? 587),
    security: r[KEYS.security] === "ssl" ? "ssl" : "starttls",
    user: r[KEYS.user] || null,
    password: decryptOptional(r[KEYS.password]),
    from: r[KEYS.from],
    to: r[KEYS.to],
  };
}

/** Vue des réglages : jamais le mot de passe, seulement s'il est posé. */
export async function getSmtpSettings(): Promise<SmtpSettings> {
  const r = await rows();
  return {
    host: r[KEYS.host] ?? null,
    port: r[KEYS.port] ? Number(r[KEYS.port]) : null,
    security: r[KEYS.security] === "ssl" ? "ssl" : "starttls",
    user: r[KEYS.user] ?? null,
    passwordSet: Boolean(r[KEYS.password]),
    from: r[KEYS.from] ?? null,
    to: r[KEYS.to] ?? null,
    configured: Boolean(r[KEYS.host] && r[KEYS.from] && r[KEYS.to]),
  };
}

const optionalText = (max: number) => z.string().max(max).nullable().optional();
const smtpSchema = z
  .object({
    host: optionalText(253),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    security: z.enum(["ssl", "starttls"]).optional(),
    user: optionalText(254),
    // Vide ou absent : inchangé ; null : retiré.
    password: z.string().max(1024).nullable().optional(),
    from: optionalText(254),
    to: optionalText(254),
  })
  .strict();

const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

export async function updateSmtpSettings(body: unknown): Promise<SmtpSettings> {
  const parsed = smtpSchema.safeParse(body ?? {});
  if (!parsed.success) throw new HttpError(400, "Réglages SMTP invalides.");
  const input = parsed.data;
  const clean = (v: string | null | undefined) => (v === undefined ? undefined : (v ?? "").trim() || null);
  const host = clean(input.host);
  const user = clean(input.user);
  const from = clean(input.from);
  const to = clean(input.to);
  if (host && !HOST_RE.test(host)) throw Object.assign(new HttpError(400, "Serveur SMTP invalide (nom d'hôte attendu).", "invalid_field"), { field: "host" });
  if (from && !isEmail(from)) throw Object.assign(new HttpError(400, "Adresse d'expédition invalide.", "invalid_field"), { field: "from" });
  if (to && !isEmail(to)) throw Object.assign(new HttpError(400, "Adresse de réception invalide.", "invalid_field"), { field: "to" });
  if (user && /[\u0000-\u001f\u007f]/.test(user)) throw Object.assign(new HttpError(400, "Identifiant invalide.", "invalid_field"), { field: "user" });

  const changes: Array<[string, string | null]> = [];
  if (host !== undefined) changes.push([KEYS.host, host]);
  if (input.port !== undefined) changes.push([KEYS.port, input.port === null ? null : String(input.port)]);
  if (input.security !== undefined) changes.push([KEYS.security, input.security]);
  if (user !== undefined) changes.push([KEYS.user, user]);
  if (input.password === null) changes.push([KEYS.password, null]);
  else if (input.password) changes.push([KEYS.password, encrypt(input.password)]);
  if (from !== undefined) changes.push([KEYS.from, from]);
  if (to !== undefined) changes.push([KEYS.to, to]);
  await prisma.$transaction(
    changes.map(([key, value]) =>
      value === null ? prisma.hubSetting.deleteMany({ where: { key } }) : prisma.hubSetting.upsert({ where: { key }, create: { key, value }, update: { value } }),
    ),
  );
  return getSmtpSettings();
}

export type MailMessage = SendMailOptions;
/** Envoi d'un message ; remplacé dans les tests (aucun réseau). */
export type MailSender = (config: SmtpConfig, message: MailMessage) => Promise<void>;

/** Délais de l'envoi : courts, pour qu'une sortie bloquée réponde bien avant les 100 s du tunnel Cloudflare. */
export type SmtpDelays = { connectionMs: number; greetingMs: number; socketMs: number; dnsMs: number; totalMs: number };
export const SMTP_DELAYS: SmtpDelays = { connectionMs: 10_000, greetingMs: 10_000, socketMs: 20_000, dnsMs: 10_000, totalMs: 45_000 };

export function makeSmtpSender(delays: SmtpDelays = SMTP_DELAYS): MailSender {
  return async (config, message) => {
    const options: SMTPTransport.Options = {
      host: config.host,
      port: config.port,
      secure: config.security === "ssl",
      requireTLS: config.security === "starttls",
      auth: config.user ? { user: config.user, pass: config.password ?? "" } : undefined,
      connectionTimeout: delays.connectionMs,
      greetingTimeout: delays.greetingMs,
      socketTimeout: delays.socketMs,
      dnsTimeout: delays.dnsMs,
    };
    const transport = nodemailer.createTransport(options);
    let timer: NodeJS.Timeout | undefined;
    try {
      // Plafond d'ensemble : quelle que soit l'étape qui traîne, une réponse part.
      await Promise.race([
        transport.sendMail(message),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error("délai total"), { code: "ETOTAL" })), delays.totalMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      transport.close();
    }
  };
}

export const smtpSender: MailSender = makeSmtpSender();

/**
 * Cause d'un échec d'envoi, en clair : DNS, connexion refusée, délai, TLS, authentification (code SMTP), adresse.
 * Jamais le mot de passe ni l'identifiant (retirés du texte du serveur s'il les répète).
 */
export function sendFailure(err: unknown, config?: Pick<SmtpConfig, "host" | "port" | "user" | "password"> | null): string {
  const e = err as { code?: string; responseCode?: number; response?: string; message?: string } | null;
  const where = config ? `${config.host}:${config.port}` : "le serveur SMTP";
  const text = `${e?.message ?? ""} ${e?.response ?? ""}`;
  const clean = (v: string) => {
    let out = v.replace(/[\r\n]+/g, " ").trim();
    for (const secret of [config?.password, config?.user]) if (secret && secret.length >= 3) out = out.split(secret).join("••••");
    return out.slice(0, 160);
  };
  const tls = "465 = SSL, 587 = STARTTLS";
  if (e?.code === "ETOTAL") return `Pas de réponse complète de ${where} en ${Math.round(SMTP_DELAYS.totalMs / 1000)} s : sortie lente ou bloquée.`;
  if (e?.code === "EDNS" || /ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(text)) return `Serveur SMTP introuvable (DNS) : « ${config?.host ?? "?"} » ne se résout pas depuis le hub.`;
  if (/ECONNREFUSED/.test(text)) return `Connexion refusée par ${where} : port fermé ou mauvais port (${tls}).`;
  if (/ENETUNREACH|EHOSTUNREACH/.test(text)) return `${where} injoignable depuis le hub (réseau) : sortie bloquée par un pare-feu ?`;
  if (e?.code === "ETIMEDOUT" || /timeout|timed out|ETIMEDOUT/i.test(text))
    return `Pas de réponse de ${where} dans le délai : sortie bloquée par un pare-feu, ou chiffrement inadapté au port (${tls}).`;
  if (e?.code === "ETLS" || /ssl|tls|certificate|wrong version number|EPROTO/i.test(text))
    return `Échec TLS avec ${where} : chiffrement inadapté au port (${tls}) ou certificat refusé (${clean(e?.message ?? "")}).`;
  if (e?.code === "EAUTH") return `Authentification refusée par ${where}${e.responseCode ? ` (code ${e.responseCode})` : ""} : identifiant ou mot de passe.`;
  if (e?.code === "EENVELOPE") return `Adresse refusée par ${where}${e.responseCode ? ` (code ${e.responseCode})` : ""} : l'adresse d'expédition doit appartenir au compte SMTP.`;
  if (e?.responseCode) return `${where} refuse l'envoi (code ${e.responseCode}${e.response ? ` : ${clean(e.response)}` : ""}).`;
  return `Envoi impossible par ${where}${e?.code ? ` (${e.code})` : ""}.`;
}
