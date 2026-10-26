import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Site } from "@prisma/client";
import PostalMime, { decodeWords, type Email } from "postal-mime";
import type { PhpMailDetail, PhpMailRedirect, PhpMailSummary } from "@/contract.js";
import { audit } from "@/lib/audit.js";
import { HttpError } from "@/lib/http.js";
import { isEmail, sendFailure, smtpConfig, type MailMessage, type MailSender, type SmtpConfig } from "@/lib/mailer.js";
import type { PhpAgentMail } from "@/lib/php-agent/client.js";
import { agentOf } from "@/lib/php-sites.js";
import { prisma } from "@/lib/prisma.js";
import type { Services } from "@/lib/services.js";

// E-mails capturés des sites PHP (docs/cadrage.md, 11.6, lot P5). L'agent les garde (100 par site) ; le hub les lit
// à la demande, les décode (postal-mime), rend le HTML dans un cadre isolé et, sur demande ou par l'option de
// redirection, les remet aux seules adresses autorisées par son propre SMTP. Jamais au destinataire d'origine.

export const MAIL_RECIPIENTS_MAX = 10;
/** Débit des remises par site (bouton et redirection confondus). */
export const FORWARDS_PER_HOUR = 30;
/** Pièces jointes remises : 10 Mio au total, les suivantes retirées (et nommées dans le message). */
export const FORWARD_ATTACHMENTS_BYTES = 10 * 1024 * 1024;
const CID_INLINE_BYTES = 5 * 1024 * 1024;
const MAIL_ID_RE = /^[0-9]{13}-[0-9a-f]{8}$/;

export function checkMailId(id: string): string {
  if (!MAIL_ID_RE.test(id)) throw new HttpError(404, "E-mail introuvable.");
  return id;
}

const decode = (v: string | null) => {
  if (!v) return null;
  try {
    return decodeWords(v).replace(/[\r\n]+/g, " ").trim() || null;
  } catch {
    return v;
  }
};

/** Destinataires d'origine : l'enveloppe (Cci compris), sinon l'en-tête To. */
function recipientsOf(meta: PhpAgentMail): string[] {
  if (meta.envelopeTo.length && !meta.envelopeTo.every((a) => a.endsWith("@capture.invalid"))) return meta.envelopeTo;
  return meta.to ? [decode(meta.to)!] : [];
}

export function summaryOf(meta: PhpAgentMail): PhpMailSummary {
  return { id: meta.id, receivedAt: meta.receivedAt, size: meta.size, subject: decode(meta.subject), from: decode(meta.from), to: recipientsOf(meta), attachments: meta.attachments };
}

export function redirectOf(site: Pick<Site, "phpMailRedirect" | "phpMailRecipients">): PhpMailRedirect {
  return { enabled: site.phpMailRedirect, recipients: (site.phpMailRecipients ?? "").split("\n").filter(Boolean) };
}

/** Adresses autorisées saisies : valides, sans doublon, 10 au plus. */
export function parseRecipients(input: string[]): string[] {
  const out: string[] = [];
  for (const raw of input) {
    const a = raw.trim().toLowerCase();
    if (!a) continue;
    if (!isEmail(a)) throw Object.assign(new HttpError(400, `Adresse invalide : « ${raw.slice(0, 80)} ».`, "invalid_field"), { field: "recipients" });
    if (!out.includes(a)) out.push(a);
  }
  if (out.length > MAIL_RECIPIENTS_MAX) throw Object.assign(new HttpError(400, `${MAIL_RECIPIENTS_MAX} adresses au plus.`, "invalid_field"), { field: "recipients" });
  return out;
}

// --- Lecture d'un e-mail (téléchargé de l'agent, gardé un instant pour le détail, le HTML et les pièces) ---

type Loaded = { raw: Buffer; email: Email; meta: PhpAgentMail };
const cache = new Map<string, { at: number; value: Promise<Loaded> }>();
const CACHE_ENTRIES = 4;
const CACHE_MS = 5 * 60_000;

export async function loadMail(services: Services, site: Pick<Site, "slug">, id: string): Promise<Loaded> {
  checkMailId(id);
  const key = `${site.slug}/${id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = (async () => {
    const agent = agentOf(services);
    const meta = (await agent.mails(site.slug)).find((m) => m.id === id);
    if (!meta) throw new HttpError(404, "E-mail introuvable (retiré, ou sorti des 100 gardés).");
    const dir = path.join(services.dataDir, "tmp");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `mail-${randomBytes(8).toString("hex")}.eml`);
    try {
      await agent.downloadMail(site.slug, id, file);
      const raw = await readFile(file);
      const email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
      return { raw, email, meta };
    } finally {
      await rm(file, { force: true });
    }
  })();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  return value;
}

export function forgetMail(slug: string, id?: string): void {
  for (const key of [...cache.keys()]) if (key === `${slug}/${id}` || (!id && key.startsWith(`${slug}/`))) cache.delete(key);
}

const bytesOf = (content: ArrayBuffer | Uint8Array | string) => (typeof content === "string" ? Buffer.from(content) : Buffer.from(content as ArrayBuffer));
const addressText = (a: { name?: string; address?: string } | undefined) => (a ? (a.name ? `${a.name} <${a.address ?? ""}>` : (a.address ?? "")) : "");
const REMOTE_RE = /(?:\b(?:src|background|poster)\s*=\s*["']?\s*(?:https?:)?\/\/)|(?:url\(\s*["']?\s*(?:https?:)?\/\/)|(?:\bsrcset\s*=\s*["'][^"']*https?:\/\/)/i;

export function detailOf(loaded: Loaded): PhpMailDetail {
  const { email, meta } = loaded;
  return {
    ...summaryOf(meta),
    subject: email.subject ?? decode(meta.subject),
    from: addressText(email.from) || decode(meta.from),
    cc: (email.cc ?? []).map(addressText).filter(Boolean),
    date: email.date ?? null,
    headers: email.headers.map((h) => ({ name: h.key, value: h.value.slice(0, 4000) })),
    text: email.text ?? null,
    hasHtml: Boolean(email.html),
    remoteContent: Boolean(email.html && REMOTE_RE.test(email.html)),
    attachmentsList: email.attachments.map((a, index) => ({
      index,
      filename: a.filename ?? `piece-${index + 1}`,
      mimeType: a.mimeType || "application/octet-stream",
      size: bytesOf(a.content).length,
      inline: a.disposition === "inline" || Boolean(a.related),
    })),
  };
}

/**
 * HTML de l'e-mail pour le cadre isolé : images intégrées (cid:) remplacées par des données, liens ouverts dans un
 * nouvel onglet. La sécurité ne tient pas à ce texte mais à la CSP et au sandbox de la réponse (mailHtmlCsp).
 */
export function mailHtml(loaded: Loaded): string | null {
  const { email } = loaded;
  if (!email.html) return null;
  const byCid = new Map(email.attachments.filter((a) => a.contentId).map((a) => [a.contentId!.replace(/^<|>$/g, "").toLowerCase(), a]));
  const html = email.html.replace(/cid:([^"'\s)>]+)/gi, (whole, cid: string) => {
    const a = byCid.get(decodeURIComponent(cid).toLowerCase());
    if (!a) return whole;
    const bytes = bytesOf(a.content);
    return bytes.length <= CID_INLINE_BYTES ? `data:${a.mimeType || "application/octet-stream"};base64,${bytes.toString("base64")}` : whole;
  });
  return `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><base target="_blank">${html}`;
}

/** CSP du cadre : aucun script, aucun formulaire, rien de distant sauf sur demande (images, styles, polices). */
export function mailHtmlCsp(remote: boolean): string {
  const far = remote ? " https: http:" : "";
  return [
    "default-src 'none'",
    `img-src data:${far}`,
    `style-src 'unsafe-inline'${far}`,
    `font-src data:${far}`,
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
    "sandbox allow-popups allow-popups-to-escape-sandbox",
  ].join("; ");
}

export function attachmentOf(loaded: Loaded, index: number): { filename: string; mimeType: string; content: Buffer } {
  const a = loaded.email.attachments[index];
  if (!a) throw new HttpError(404, "Pièce jointe introuvable.");
  return { filename: a.filename ?? `piece-${index + 1}`, mimeType: a.mimeType || "application/octet-stream", content: bytesOf(a.content) };
}

// --- Remise aux adresses autorisées ---

/** Fenêtre glissante d'une heure par site : 30 remises au plus. */
export class ForwardLimiter {
  private readonly sent = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}
  take(siteId: string): boolean {
    const t = this.now();
    const recent = (this.sent.get(siteId) ?? []).filter((at) => t - at < 3_600_000);
    if (recent.length >= FORWARDS_PER_HOUR) {
      this.sent.set(siteId, recent);
      return false;
    }
    recent.push(t);
    this.sent.set(siteId, recent);
    return true;
  }
}

const oneLine = (v: string, max = 300) => v.replace(/[\r\n\t]+/g, " ").trim().slice(0, max);

/**
 * Message remis : expéditeur = le compte du hub (jamais l'adresse du site, refusée par SPF/DMARC), destinataire
 * d'origine dans l'objet et dans X-Kouzia-Original-To, réponse vers l'expéditeur d'origine.
 */
export function forwardMessage(loaded: Loaded, config: SmtpConfig, to: string[], siteHost: string): MailMessage {
  const { email, meta } = loaded;
  const originalTo = oneLine(summaryOf(meta).to.join(", ")) || "destinataire inconnu";
  const subject = oneLine(email.subject ?? decode(meta.subject) ?? "(sans objet)", 500);
  const attachments: NonNullable<MailMessage["attachments"]> = [];
  const dropped: string[] = [];
  let total = 0;
  for (const a of email.attachments) {
    const content = bytesOf(a.content);
    const name = a.filename ?? "piece";
    if (total + content.length > FORWARD_ATTACHMENTS_BYTES) {
      dropped.push(`${name} (${Math.round(content.length / 1024)} Kio)`);
      continue;
    }
    total += content.length;
    attachments.push({
      filename: name,
      content,
      contentType: a.mimeType || "application/octet-stream",
      ...(a.contentId ? { cid: a.contentId.replace(/^<|>$/g, "") } : {}),
      contentDisposition: a.disposition === "inline" ? "inline" : "attachment",
    });
  }
  const note = dropped.length ? `Pièces jointes retirées (plus de ${FORWARD_ATTACHMENTS_BYTES / 1024 / 1024} Mio au total) : ${dropped.join(", ")}.` : "";
  const replyTo = email.from?.address && isEmail(email.from.address) ? email.from.address : undefined;
  return {
    from: config.from,
    to,
    ...(replyTo ? { replyTo } : {}),
    subject: `[recette pour ${originalTo}] ${subject}`,
    headers: {
      "X-Kouzia-Original-To": originalTo,
      "X-Kouzia-Original-From": oneLine(addressText(email.from) || decode(meta.from) || "inconnu"),
      "X-Kouzia-Site": oneLine(siteHost),
    },
    text: [note, email.text ?? ""].filter(Boolean).join("\n\n") || undefined,
    html: email.html ? (note ? `<p>${note.replace(/[<>&]/g, "")}</p>${email.html}` : email.html) : undefined,
    attachments,
  };
}

export type ForwardDeps = { services: Services; sender: MailSender; limiter: ForwardLimiter };

/** Remet un e-mail capturé ; refus clair si le SMTP du hub n'est pas réglé ou si le débit du site est atteint. */
export async function forwardMail(deps: ForwardDeps, site: Site, id: string, to: string[] | null, reason: "bouton" | "redirection"): Promise<string[]> {
  const config = await smtpConfig();
  if (!config) throw new HttpError(409, "SMTP du hub non réglé (Réglages, tuile « Envoi d'e-mails ») : rien n'est envoyé.", "smtp_unset");
  const recipients = to?.length ? to : [config.to];
  if (!deps.limiter.take(site.id)) throw new HttpError(429, `Débit atteint : ${FORWARDS_PER_HOUR} e-mails remis par heure et par site au plus.`, "mail_rate");
  const loaded = await loadMail(deps.services, site, id);
  try {
    await deps.sender(config, forwardMessage(loaded, config, recipients, `${site.slug}.${deps.services.sitesDomain}`));
  } catch (err) {
    const message = sendFailure(err);
    await audit({ action: "site.php.mail.forward", result: "error", siteId: site.id, siteSlug: site.slug, detail: `${reason} : ${message}` });
    throw new HttpError(502, message, "smtp_failed");
  }
  await audit({ action: "site.php.mail.forward", result: "ok", siteId: site.id, siteSlug: site.slug, detail: `${reason}, ${id} vers ${recipients.length} adresse(s) autorisée(s)` });
  return recipients;
}

// --- Redirection : relève chaque minute des sites qui l'ont activée ---

const markerKey = (siteId: string) => `php.mail.last.${siteId}`;
/** Repère « tout ce qui est arrivé avant maintenant est déjà traité » (pose de l'option). */
export const markerNow = (now = Date.now()) => `${String(now).padStart(13, "0")}-ffffffff`;

export async function setRedirectMarker(siteId: string, value: string): Promise<void> {
  await prisma.hubSetting.upsert({ where: { key: markerKey(siteId) }, create: { key: markerKey(siteId), value }, update: { value } });
}

/** Un passage : pour chaque site redirigé, les e-mails arrivés depuis le repère, du plus ancien au plus récent. */
export async function forwardNewMails(deps: ForwardDeps): Promise<number> {
  if (!deps.services.phpAgent || !(await smtpConfig())) return 0;
  let sent = 0;
  const sites = await prisma.site.findMany({ where: { hosting: "php", phpMailRedirect: true, state: "ONLINE" } });
  for (const site of sites) {
    try {
      const marker = (await prisma.hubSetting.findUnique({ where: { key: markerKey(site.id) } }))?.value ?? markerNow();
      const fresh = (await deps.services.phpAgent.mails(site.slug)).filter((m) => m.id > marker).sort((a, b) => a.id.localeCompare(b.id));
      let last = marker;
      let limited = 0;
      try {
        for (const m of fresh) {
          try {
            await forwardMail(deps, site, m.id, redirectOf(site).recipients, "redirection");
            sent += 1;
          } catch (err) {
            // Débit atteint : non remis (un site en boucle ne remplit pas une boîte), compté. SMTP en échec : arrêt,
            // le repère reste avant cet e-mail, repris au passage suivant.
            if (!(err instanceof HttpError && err.code === "mail_rate")) throw err;
            limited += 1;
          }
          last = m.id;
        }
      } finally {
        // Ce qui est déjà remis ne l'est jamais deux fois.
        if (last !== marker) await setRedirectMarker(site.id, last);
        if (limited) await audit({ action: "site.php.mail.forward", result: "error", siteId: site.id, siteSlug: site.slug, detail: `redirection : ${limited} e-mail(s) non remis, débit de ${FORWARDS_PER_HOUR} par heure atteint` });
      }
    } catch (err) {
      console.error(`[e-mails] redirection de ${site.slug} impossible :`, err instanceof Error ? err.message : err);
    }
  }
  return sent;
}

export function startPhpMailRedirect(deps: ForwardDeps): NodeJS.Timeout {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void forwardNewMails(deps)
      .catch((err) => console.error("[e-mails] redirection impossible :", err instanceof Error ? err.message : err))
      .finally(() => (running = false));
  }, 60_000);
  timer.unref();
  return timer;
}
