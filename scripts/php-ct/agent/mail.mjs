// Capteur d'e-mails des sites PHP (docs/cadrage.md, section 11.6, lot P5). Aucun e-mail ne quitte le CT : le capteur
// écoute en SMTP sur 127.0.0.1 seulement, reconnaît le site par le compte (UID) qui ouvre la connexion et range le
// message dans le dépôt de l'agent (/var/lib/kouziaphp/mail/<slug>/, à root, 700), hors de portée du site. Un UID
// qui n'est pas celui d'un site connu est refusé. Le sendmail_path des sites (mail-capture) passe par ce même point.
// Plafonds : 25 Mo par message, 100 messages et 100 Mio par site (les plus anciens retirés d'abord).

import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

export const MAIL_PORT = 1025;
export const MAIL_MAX_BYTES = 25 * 1024 * 1024;
export const MAILS_KEPT = 100;
export const MAIL_QUOTA_BYTES = 100 * 1024 * 1024;
export const MAIL_ID_RE = /^[0-9]{13}-[0-9a-f]{8}$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_RCPT = 100;
const MAX_LINE = 4096;
const IDLE_MS = 60_000;

const opError = (status, message) => Object.assign(new Error(message), { status });

// --- Identification du site par le compte de la connexion ---

const hexPort = (port) => port.toString(16).toUpperCase().padStart(4, "0");

/**
 * UID du socket client d'une connexion locale, lu dans /proc/net/tcp : la ligne dont l'adresse locale est
 * 127.0.0.1:<port du client> et l'adresse distante 127.0.0.1:<port du capteur>. Absente : null.
 */
export function uidFromProcNet(text, clientPort, serverPort) {
  const local = `0100007F:${hexPort(clientPort)}`;
  const remote = `0100007F:${hexPort(serverPort)}`;
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 8 && cols[1] === local && cols[2] === remote && /^[0-9]+$/.test(cols[7])) return Number(cols[7]);
  }
  return null;
}

/** Slug du site dont le compte php-<slug> a cet UID (plage des sites), ou null. */
export function slugOfUid(passwd, uid, uidMin = 20000, uidMax = 29999) {
  if (!Number.isInteger(uid) || uid < uidMin || uid > uidMax) return null;
  for (const line of passwd.split("\n")) {
    const [name, , id] = line.split(":");
    if (id === String(uid) && name?.startsWith("php-") && SLUG_RE.test(name.slice(4))) return name.slice(4);
  }
  return null;
}

// --- Résumé d'un message (liste du hub) ---

/** En-têtes dépliés du message (64 Kio au plus), en UTF-8. */
function headerBlock(raw) {
  const head = raw.subarray(0, 64 * 1024).toString("utf8");
  const end = head.search(/\r?\n\r?\n/);
  return (end < 0 ? head : head.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
}

function header(block, name) {
  const m = new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(block);
  return m ? m[1].trim().slice(0, 1000) : null;
}

export function summarize(id, raw, envelope, receivedAt) {
  const block = headerBlock(raw);
  return {
    id,
    receivedAt,
    size: raw.length,
    envelopeFrom: envelope.from.slice(0, 320),
    envelopeTo: envelope.to.slice(0, MAX_RCPT).map((a) => a.slice(0, 320)),
    subject: header(block, "Subject"),
    from: header(block, "From"),
    to: header(block, "To"),
    date: header(block, "Date"),
    attachments: (raw.toString("latin1").match(/^content-disposition:[ \t]*attachment/gim) ?? []).length,
  };
}

// --- Dépôt des messages ---

/** Dépôt des messages capturés, un dossier par site ; chaque message : <id>.eml et son résumé <id>.json. */
export function mailStore({ dir, now = Date.now, kept = MAILS_KEPT, quota = MAIL_QUOTA_BYTES }) {
  const siteDir = (slug) => {
    if (!SLUG_RE.test(slug)) throw opError(400, "Site invalide.");
    return path.join(dir, slug);
  };
  const checkId = (id) => {
    if (!MAIL_ID_RE.test(id)) throw opError(400, "E-mail invalide.");
    return id;
  };
  const ids = async (slug) => {
    const names = await fsp.readdir(siteDir(slug)).catch(() => []);
    return names.filter((n) => n.endsWith(".eml") && MAIL_ID_RE.test(n.slice(0, -4))).map((n) => n.slice(0, -4)).sort().reverse();
  };
  const removeOne = async (slug, id) => {
    await fsp.rm(path.join(siteDir(slug), `${id}.eml`), { force: true });
    await fsp.rm(path.join(siteDir(slug), `${id}.json`), { force: true });
  };

  /** Plus récents d'abord : gardés tant que le nombre et le volume tiennent ; les autres retirés. */
  const rotate = async (slug) => {
    let total = 0;
    let count = 0;
    for (const id of await ids(slug)) {
      const size = (await fsp.stat(path.join(siteDir(slug), `${id}.eml`)).catch(() => null))?.size ?? 0;
      if (count < kept && (count === 0 || total + size <= quota)) {
        count += 1;
        total += size;
      } else await removeOne(slug, id);
    }
  };

  return {
    async save(slug, raw, envelope) {
      const d = siteDir(slug);
      await fsp.mkdir(d, { recursive: true, mode: 0o700 });
      const at = now();
      const id = `${String(at).padStart(13, "0")}-${randomBytes(4).toString("hex")}`;
      const meta = summarize(id, raw, envelope, new Date(at).toISOString());
      // « wx » : jamais d'écrasement (nom aléatoire, création exclusive).
      await fsp.writeFile(path.join(d, `${id}.eml`), raw, { flag: "wx", mode: 0o600 });
      await fsp.writeFile(path.join(d, `${id}.json`), `${JSON.stringify(meta)}\n`, { flag: "wx", mode: 0o600 });
      await rotate(slug);
      return meta;
    },
    async list(slug) {
      const out = [];
      for (const id of await ids(slug)) {
        const meta = await fsp.readFile(path.join(siteDir(slug), `${id}.json`), "utf8").then(JSON.parse, () => null);
        if (meta) out.push(meta);
      }
      return { mails: out };
    },
    /** Fichier du message, gardé après l'envoi (téléchargement signé de l'agent). */
    async file(slug, id) {
      const file = path.join(siteDir(slug), `${checkId(id)}.eml`);
      if (!(await fsp.stat(file).catch(() => null))) throw opError(404, "E-mail introuvable (retiré par la rotation ?).");
      return { file, keep: true, type: "message/rfc822" };
    },
    async remove(slug, id) {
      await removeOne(slug, checkId(id));
      return { ok: true };
    },
    async clear(slug) {
      const all = await ids(slug);
      for (const id of all) await removeOne(slug, id);
      return { removed: all.length };
    },
    /** Site retiré : son dossier avec. */
    async drop(slug) {
      await fsp.rm(siteDir(slug), { recursive: true, force: true });
    },
  };
}

// --- Serveur SMTP local ---

/**
 * Serveur SMTP du capteur (à écouter sur 127.0.0.1). siteOf(socket) rend le slug du site de la connexion ou null
 * (refus). Aucune authentification réelle : AUTH est annoncé et accepté (identifiants ignorés, jamais gardés) pour
 * les bibliothèques qui l'exigent quand un identifiant est posé ; pas de STARTTLS (connexion locale).
 */
export function createMailCatcher({ store, siteOf, maxBytes = MAIL_MAX_BYTES, log = () => {} }) {
  const server = createServer((socket) => {
    socket.setTimeout(IDLE_MS, () => socket.destroy());
    socket.on("error", () => {});
    const write = (line) => {
      if (!socket.destroyed) socket.write(`${line}\r\n`);
    };
    let slug = null;
    let inbuf = Buffer.alloc(0);
    let busy = true;
    let mode = "command";
    let auth = null;
    let from = null;
    let to = [];
    let data = null;
    let tail = Buffer.alloc(0);
    let dataSize = 0;
    let overflow = false;

    const reset = () => {
      from = null;
      to = [];
    };

    const command = async (line) => {
      if (auth) {
        // Réponses d'AUTH (identifiants ignorés).
        if (auth === "login-user") {
          auth = "login-pass";
          return write("334 UGFzc3dvcmQ6");
        }
        auth = null;
        return write("235 2.7.0 Accepte (identifiants ignores, rien n'est envoye)");
      }
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === "EHLO") {
        reset();
        return write(`250-kouziaphp capteur\r\n250-SIZE ${maxBytes}\r\n250-8BITMIME\r\n250-SMTPUTF8\r\n250 AUTH PLAIN LOGIN`);
      }
      if (verb === "HELO") {
        reset();
        return write("250 kouziaphp capteur");
      }
      if (verb === "AUTH") {
        const [, mech, initial] = line.split(/\s+/);
        if (/^PLAIN$/i.test(mech ?? "")) {
          if (initial) return write("235 2.7.0 Accepte (identifiants ignores, rien n'est envoye)");
          auth = "plain";
          return write("334 ");
        }
        if (/^LOGIN$/i.test(mech ?? "")) {
          auth = initial ? "login-pass" : "login-user";
          return write(initial ? "334 UGFzc3dvcmQ6" : "334 VXNlcm5hbWU6");
        }
        return write("504 5.5.4 Mecanisme non pris en charge");
      }
      if (/^MAIL FROM:/i.test(line)) {
        const m = /^MAIL FROM:\s*<([^>]*)>(.*)$/i.exec(line);
        if (!m) return write("501 5.5.4 Syntaxe : MAIL FROM:<adresse>");
        const size = /\bSIZE=(\d+)/i.exec(m[2]);
        if (size && Number(size[1]) > maxBytes) return write("552 5.3.4 Message trop lourd (25 Mo au plus)");
        from = m[1];
        to = [];
        return write("250 2.1.0 OK");
      }
      if (/^RCPT TO:/i.test(line)) {
        const m = /^RCPT TO:\s*<([^>]*)>/i.exec(line);
        if (!m) return write("501 5.5.4 Syntaxe : RCPT TO:<adresse>");
        if (from === null) return write("503 5.5.1 MAIL FROM d'abord");
        if (to.length >= MAX_RCPT) return write("452 4.5.3 Trop de destinataires");
        to.push(m[1]);
        return write("250 2.1.5 OK (capture, jamais envoye)");
      }
      if (verb === "DATA") {
        if (from === null || !to.length) return write("503 5.5.1 MAIL FROM et RCPT TO d'abord");
        mode = "data";
        // Fin de message : <CRLF>.<CRLF> ; le CRLF de tête permet un message vide.
        data = [Buffer.from("\r\n")];
        tail = Buffer.from("\r\n");
        dataSize = 2;
        overflow = false;
        return write("354 Fin par <CR><LF>.<CR><LF>");
      }
      if (verb === "RSET") {
        reset();
        return write("250 2.0.0 OK");
      }
      if (verb === "NOOP") return write("250 2.0.0 OK");
      if (verb === "VRFY") return write("252 2.1.5 Non verifie");
      if (verb === "QUIT") {
        write("221 2.0.0 Au revoir");
        return socket.end();
      }
      return write("502 5.5.2 Commande non prise en charge");
    };

    /** Message reçu : points de tête rétablis, rangé dans le dépôt du site. */
    const finish = async (body) => {
      const envelope = { from, to };
      reset();
      // Plafond vérifié aussi ici : un message reçu d'un seul morceau n'est pas passé par la lecture en flux.
      if (overflow || body.length - 2 > maxBytes) return write("552 5.3.4 Message trop lourd (25 Mo au plus)");
      const raw = Buffer.from(body.toString("latin1").split("\r\n..").join("\r\n.").slice(2) + "\r\n", "latin1");
      try {
        const meta = await store.save(slug, raw, envelope);
        log(`capture ${slug} ${meta.id} ${raw.length} octets`);
        return write(`250 2.0.0 Capture ${meta.id} (jamais envoye)`);
      } catch {
        return write("451 4.3.0 Capture impossible");
      }
    };

    const pump = async () => {
      if (busy) return;
      busy = true;
      try {
        while (!socket.destroyed) {
          if (mode === "data") {
            // Terminateur cherché à la jonction seulement : 4 derniers octets reçus et morceau nouveau.
            const probe = Buffer.concat([tail, inbuf]);
            const at = probe.indexOf("\r\n.\r\n");
            if (at < 0) {
              dataSize += inbuf.length;
              // Au-delà du plafond : le reste est lu puis jeté.
              if (dataSize > maxBytes + 2) {
                overflow = true;
                data = [];
              } else if (inbuf.length) data.push(inbuf);
              tail = probe.subarray(Math.max(0, probe.length - 4));
              inbuf = Buffer.alloc(0);
              break;
            }
            // Fin dans le morceau nouveau (cut >= 0) ou déjà commencée dans les octets gardés (cut < 0).
            const cut = at - tail.length;
            let body = overflow ? Buffer.alloc(0) : Buffer.concat([...data, inbuf.subarray(0, Math.max(0, cut))]);
            if (cut < 0 && !overflow) body = body.subarray(0, body.length + cut);
            inbuf = inbuf.subarray(cut + 5);
            mode = "command";
            data = null;
            await finish(body);
            continue;
          }
          const nl = inbuf.indexOf("\n");
          if (nl < 0) {
            if (inbuf.length > MAX_LINE) {
              write("500 5.5.6 Ligne trop longue");
              socket.destroy();
            }
            break;
          }
          const line = inbuf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
          inbuf = inbuf.subarray(nl + 1);
          await command(line);
        }
      } finally {
        busy = false;
      }
    };

    socket.on("data", (chunk) => {
      inbuf = Buffer.concat([inbuf, chunk]);
      void pump();
    });

    void (async () => {
      slug = await Promise.resolve(siteOf(socket)).catch(() => null);
      if (!slug) {
        write("554 5.7.1 Compte non autorise : seuls les sites PHP du CT deposent ici");
        socket.end();
        return;
      }
      write("220 kouziaphp capteur ESMTP (aucun e-mail n'est envoye)");
      busy = false;
      void pump();
    })();
  });
  server.maxConnections = 20;
  return server;
}
