import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { connect, type AddressInfo, type Server as NetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PhpAgentClient } from "@/lib/php-agent/client.js";
import { createAgent, type Probes } from "../../../../../scripts/php-ct/agent/agent.mjs";
import { createMailCatcher, mailStore, slugOfUid, uidFromProcNet, type MailStore } from "../../../../../scripts/php-ct/agent/mail.mjs";

// Capteur d'e-mails du CT PHP (docs/cadrage.md, 11.6, lot P5) : vrai serveur SMTP local, vrai dépôt (dossier
// temporaire), vrai script mail-capture (sendmail_path des sites), vraies routes signées de l'agent.
const MAIL_CAPTURE = fileURLToPath(new URL("../../../../../scripts/php-ct/mail-capture", import.meta.url));
const SECRET = "s".repeat(48);

let dir: string;
let clock: number;
let store: MailStore;
const servers: Array<Server | NetServer> = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "kouzia-mail-"));
  clock = Date.parse("2026-10-26T10:00:00Z");
  store = mailStore({ dir, now: () => clock++ });
});
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  rmSync(dir, { recursive: true, force: true });
});

async function catcher(siteOf: () => string | null, maxBytes?: number) {
  const s = createMailCatcher({ store, siteOf, maxBytes });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
}

/** Dialogue SMTP : chaque élément part après la réponse finale à l'élément d'avant ; réponses finales rendues. */
function smtp(port: number, items: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    const replies: string[] = [];
    const socket = connect(port, "127.0.0.1");
    let buffer = "";
    socket.on("data", (c) => {
      buffer += c.toString("latin1");
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (/^\d{3}-/.test(line)) continue;
        replies.push(line);
        const next = items.shift();
        if (next === undefined) socket.end();
        else socket.write(next.endsWith("\r\n") ? next : `${next}\r\n`);
      }
    });
    socket.on("close", () => resolve(replies));
    socket.on("error", () => resolve(replies));
  });
}

describe("capteur d'e-mails : identification du site", () => {
  it("UID du socket client lu dans /proc/net/tcp ; compte d'un site seulement", () => {
    const proc = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:0401 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1",
      "   1: 0100007F:0401 0100007F:D431 01 00000000:00000000 00:00000000 00000000     0        0 2 1",
      "   2: 0100007F:D431 0100007F:0401 01 00000000:00000000 00:00000000 00000000 20003        0 3 1",
    ].join("\n");
    expect(uidFromProcNet(proc, 0xd431, 1025)).toBe(20003);
    expect(uidFromProcNet(proc, 0xd432, 1025)).toBeNull();
    const passwd = "root:x:0:0::/root:/bin/sh\nphp-demo:x:20003:20003::/srv/sites/demo:/sbin/nologin\nnginx:x:100:101::/var/lib/nginx:/sbin/nologin\n";
    expect(slugOfUid(passwd, 20003)).toBe("demo");
    expect(slugOfUid(passwd, 0)).toBeNull();
    expect(slugOfUid(passwd, 100)).toBeNull();
    expect(slugOfUid("php-x:x:20004:20004::/:/sbin/nologin\n", 20005)).toBeNull();
  });
});

describe("capteur d'e-mails : dépôt", () => {
  const raw = (subject: string, size = 0) => Buffer.from(`Subject: ${subject}\r\nFrom: Boutique <noreply@exemple.fr>\r\nTo: client@exemple.fr\r\n\r\nBonjour${"x".repeat(size)}\r\n`);

  it("résumé à la réception, plus récents d'abord ; 100 gardés au plus (rotation des plus anciens)", async () => {
    const small = mailStore({ dir, now: () => clock++, kept: 3 });
    for (const n of [1, 2, 3, 4, 5]) await small.save("demo", raw(`n${n}`), { from: "a@b.fr", to: ["client@exemple.fr"] });
    const { mails } = await small.list("demo");
    expect(mails.map((m) => m.subject)).toEqual(["n5", "n4", "n3"]);
    expect(mails[0]).toMatchObject({ from: "Boutique <noreply@exemple.fr>", to: "client@exemple.fr", envelopeTo: ["client@exemple.fr"], attachments: 0 });
    expect(mails[0]!.receivedAt).toMatch(/^2026-10-26T10:00:00\.\d{3}Z$/);
  });

  it("quota par site : un site en boucle ne garde que ce qui tient (le plus récent toujours)", async () => {
    const tight = mailStore({ dir, now: () => clock++, quota: 2500 });
    for (const n of [1, 2, 3, 4]) await tight.save("boucle", raw(`n${n}`, 1000), { from: "", to: ["x@y.fr"] });
    expect((await tight.list("boucle")).mails.map((m) => m.subject)).toEqual(["n4", "n3"]);
    await tight.save("autre", raw("seul"), { from: "", to: ["x@y.fr"] });
    expect((await tight.list("autre")).mails).toHaveLength(1);
  });

  it("identifiant contrôlé ; fichier gardé après lecture ; retrait, vidage, dossier du site retiré", async () => {
    const meta = await store.save("demo", raw("un"), { from: "", to: ["x@y.fr"] });
    await store.save("demo", raw("deux"), { from: "", to: ["x@y.fr"] });
    await expect(store.file("demo", "../../etc/passwd")).rejects.toMatchObject({ status: 400 });
    await expect(store.file("../x", meta.id)).rejects.toMatchObject({ status: 400 });
    const f = await store.file("demo", meta.id);
    expect(f.keep).toBe(true);
    expect(readFileSync(f.file, "utf8")).toContain("Subject: un");
    await store.remove("demo", meta.id);
    await expect(store.file("demo", meta.id)).rejects.toMatchObject({ status: 404 });
    expect(await store.clear("demo")).toEqual({ removed: 1 });
    await store.drop("demo");
    expect(existsSync(path.join(dir, "demo"))).toBe(false);
  });
});

describe("capteur d'e-mails : serveur SMTP local", () => {
  it("message rangé ; points de tête rétablis ; AUTH accepté sans rien garder", async () => {
    const port = await catcher(() => "demo");
    const replies = await smtp(port, [
      "EHLO app",
      "AUTH LOGIN",
      "dXNlcg==",
      "c2VjcmV0",
      "MAIL FROM:<noreply@exemple.fr> SIZE=200",
      "RCPT TO:<client@exemple.fr>",
      "RCPT TO:<cache@exemple.fr>",
      "DATA",
      "Subject: Commande\r\nTo: client@exemple.fr\r\n\r\nLigne 1\r\n..point de tete\r\n.\r\n",
      "QUIT",
    ]);
    expect(replies[0]).toMatch(/^220 /);
    expect(replies[1]).toBe("250 AUTH PLAIN LOGIN");
    expect(replies.slice(2, 4)).toEqual(["334 VXNlcm5hbWU6", "334 UGFzc3dvcmQ6"]);
    expect(replies[4]).toMatch(/^235 /);
    expect(replies[9]).toMatch(/^250 2\.0\.0 Capture \d{13}-[0-9a-f]{8}/);
    const { mails } = await store.list("demo");
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ subject: "Commande", envelopeFrom: "noreply@exemple.fr", envelopeTo: ["client@exemple.fr", "cache@exemple.fr"] });
    const text = readFileSync((await store.file("demo", mails[0]!.id)).file, "utf8");
    expect(text).toBe("Subject: Commande\r\nTo: client@exemple.fr\r\n\r\nLigne 1\r\n.point de tete\r\n");
    const stored = readdirSync(path.join(dir, "demo")).map((n) => readFileSync(path.join(dir, "demo", n), "utf8")).join("\n");
    expect(stored).not.toMatch(/secret|c2VjcmV0|dXNlcg/);
  });

  it("commandes envoyées d'un bloc (pipelining) et message vide", async () => {
    const port = await catcher(() => "demo");
    const replies = await smtp(port, ["HELO app\r\nMAIL FROM:<>\r\nRCPT TO:<a@b.fr>\r\nDATA\r\n", ".\r\nQUIT"]);
    expect(replies.slice(0, 5).map((r) => r.slice(0, 3))).toEqual(["220", "250", "250", "250", "354"]);
    await new Promise((r) => setTimeout(r, 50));
    expect((await store.list("demo")).mails).toHaveLength(1);
  });

  it("refus : compte inconnu (rien n'est lu), message trop lourd, ordre des commandes", async () => {
    const refused = await catcher(() => null);
    expect(await smtp(refused, ["EHLO app"])).toEqual([expect.stringMatching(/^554 5\.7\.1 /)]);

    const port = await catcher(() => "demo", 1000);
    const big = `Subject: lourd\r\n\r\n${"y".repeat(5000)}\r\n.\r\n`;
    const replies = await smtp(port, ["EHLO app", "RCPT TO:<a@b.fr>", "DATA", "MAIL FROM:<a@b.fr> SIZE=5000", "MAIL FROM:<a@b.fr>", "RCPT TO:<a@b.fr>", "DATA", big, "QUIT"]);
    expect(replies.slice(2).map((r) => r.slice(0, 3))).toEqual(["503", "503", "552", "250", "250", "354", "552", "221"]);
    expect((await store.list("demo")).mails).toHaveLength(0);
  });

  it("message reçu en plusieurs morceaux : terminateur coupé entre deux morceaux, plafond en flux", async () => {
    const send = (port: number, chunks: string[]) =>
      new Promise<string>((resolve) => {
        const socket = connect(port, "127.0.0.1");
        let all = "";
        socket.on("data", (c) => (all += c.toString("latin1")));
        socket.on("close", () => resolve(all));
        void (async () => {
          for (const c of chunks) {
            await new Promise((r) => setTimeout(r, 20));
            socket.write(c);
          }
          await new Promise((r) => setTimeout(r, 50));
          socket.end();
        })();
      });
    const port = await catcher(() => "demo", 1000);
    const head = "EHLO a\r\nMAIL FROM:<a@b.fr>\r\nRCPT TO:<c@d.fr>\r\nDATA\r\n";
    const ok = await send(port, [head, "Subject: morceaux\r\n\r\nabc", "def\r\n.", "\r\nQUIT\r\n"]);
    expect(ok).toMatch(/250 2\.0\.0 Capture /);
    const { mails } = await store.list("demo");
    expect(readFileSync((await store.file("demo", mails[0]!.id)).file, "utf8")).toBe("Subject: morceaux\r\n\r\nabcdef\r\n");

    const tooBig = await send(port, [head, "x".repeat(600), "y".repeat(600), "z".repeat(600), "\r\n.\r\nQUIT\r\n"]);
    expect(tooBig).toMatch(/552 5\.3\.4 /);
    expect((await store.list("demo")).mails).toHaveLength(1);
  });

  it("mail-capture (sendmail_path) : message de PHP remis au capteur, destinataires lus dans To, Cc et Bcc", async () => {
    const port = await catcher(() => "demo");
    const message = "To: Client <client@exemple.fr>\nCc: copie@exemple.fr,\n autre@exemple.fr\nBcc: cache@exemple.fr\nSubject: Bienvenue\n\nBonjour\n.ligne qui commence par un point\n";
    const code = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [MAIL_CAPTURE, "demo", "-t", "-i", "-f", "noreply@exemple.fr"], { env: { ...process.env, KP_MAIL_PORT_TEST: String(port) } });
      child.on("close", (c) => resolve(c ?? 1));
      child.stdin.end(message);
    });
    expect(code).toBe(0);
    const { mails } = await store.list("demo");
    expect(mails[0]).toMatchObject({ subject: "Bienvenue", envelopeFrom: "noreply@exemple.fr", envelopeTo: ["client@exemple.fr", "copie@exemple.fr", "autre@exemple.fr", "cache@exemple.fr"] });
    expect(readFileSync((await store.file("demo", mails[0]!.id)).file, "utf8")).toContain("\r\nBonjour\r\n.ligne qui commence par un point\r\n");

    const refusedPort = await catcher(() => null);
    const refusedCode = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [MAIL_CAPTURE, "demo"], { env: { ...process.env, KP_MAIL_PORT_TEST: String(refusedPort) } });
      child.on("close", (c) => resolve(c ?? 1));
      child.stdin.end("To: a@b.fr\n\nx\n");
    });
    expect(refusedCode).toBe(1);
  });
});

describe("capteur d'e-mails : routes signées de l'agent", () => {
  it("liste, téléchargement vérifié (fichier gardé), retrait, vidage", async () => {
    const probes = { now: () => Date.now() } as unknown as Probes;
    const agent = createAgent({ secret: SECRET, allowedIps: ["127.0.0.1"], probes, mails: store });
    servers.push(agent);
    await new Promise<void>((r) => agent.listen(0, "127.0.0.1", r));
    const client = new PhpAgentClient({ baseUrl: `http://127.0.0.1:${(agent.address() as AddressInfo).port}`, secret: SECRET });
    const a = await store.save("demo", Buffer.from("Subject: A\r\n\r\nUn\r\n"), { from: "", to: ["x@y.fr"] });
    await store.save("demo", Buffer.from("Subject: B\r\n\r\nDeux\r\n"), { from: "", to: ["x@y.fr"] });
    expect((await client.mails("demo")).map((m) => m.subject)).toEqual(["B", "A"]);
    const out = path.join(dir, "copie.eml");
    const got = await client.downloadMail("demo", a.id, out);
    expect(got.size).toBe(18);
    expect(readFileSync(out, "utf8")).toBe("Subject: A\r\n\r\nUn\r\n");
    expect(existsSync((await store.file("demo", a.id)).file)).toBe(true);
    await client.removeMail("demo", a.id);
    await expect(client.downloadMail("demo", a.id, out)).rejects.toThrow(/introuvable/);
    expect(await client.clearMails("demo")).toBe(1);
    expect(await client.mails("demo")).toEqual([]);
  });
});
