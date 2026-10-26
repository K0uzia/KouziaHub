import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PhpMailDetail, PhpMailList, SiteDetail, SmtpSettings } from "@/contract.js";
import type { MailMessage, SmtpConfig } from "@/lib/mailer.js";
import { ForwardLimiter, FORWARDS_PER_HOUR, forwardNewMails } from "@/lib/php-mails.js";
import { PhpAgentClient } from "@/lib/php-agent/client.js";
import { createAgent, type Probes } from "../../../../../scripts/php-ct/agent/agent.mjs";
import { mailStore, type MailStore } from "../../../../../scripts/php-ct/agent/mail.mjs";
import { siteOperations, type Paths } from "../../../../../scripts/php-ct/agent/sites.mjs";
import { prisma, resetDb } from "../helpers/db.js";
import { buildTestHub, settle, type TestHub } from "../helpers/hub.js";
import { memorySys } from "../helpers/php-memory.js";

// E-mails capturés de bout en bout (docs/cadrage.md, 11.6, lot P5) : vrai hub, vrai agent (routes signées), vrai
// dépôt du capteur sur disque, envoi SMTP remplacé par un enregistreur (aucun réseau).
const SECRET = "s".repeat(48);
const paths: Paths = {
  sitesDir: "/srv/sites",
  confDir: "/etc/kouziaphp",
  nginxSitesDir: "/etc/nginx/kouziaphp-sites",
  nginxPort: 8080,
  runDir: "/run/kouziaphp",
  initDir: "/etc/init.d",
  confdDir: "/etc/conf.d",
  passwdFile: "/etc/passwd",
};

// Commande du site : texte et HTML (image intégrée cid:, image distante), facture jointe, objet encodé.
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const ORDER = [
  "From: MyTakumi <boutique@mytakumi.fr>",
  "To: Client <client@exemple.fr>",
  "Subject: =?UTF-8?B?Q29tbWFuZGUgbsKwNDIgY29uZmlybcOpZQ==?=",
  "Date: Mon, 26 Oct 2026 10:00:00 +0100",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="m"',
  "",
  "--m",
  'Content-Type: multipart/related; boundary="r"',
  "",
  "--r",
  'Content-Type: multipart/alternative; boundary="a"',
  "",
  "--a",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Merci pour votre commande.",
  "--a",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<p>Merci <img src="cid:logo@mytakumi"> <img src="https://suivi.exemple/pixel.gif"></p><script>alert(1)</script>',
  "--a--",
  "--r",
  "Content-Type: image/png",
  "Content-ID: <logo@mytakumi>",
  "Content-Disposition: inline",
  "Content-Transfer-Encoding: base64",
  "",
  PIXEL.toString("base64"),
  "--r--",
  "--m",
  'Content-Type: application/pdf; name="facture.pdf"',
  'Content-Disposition: attachment; filename="facture.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("%PDF-1.4 facture").toString("base64"),
  "--m--",
  "",
].join("\r\n");

let hub: TestHub;
let server: Server;
let store: MailStore;
let clock = Date.now();
const sent: Array<{ config: SmtpConfig; message: MailMessage }> = [];

beforeEach(async () => {
  await resetDb();
  sent.length = 0;
  clock = Date.now();
  // Création du site jusqu'au bout (page d'attente publiée) : liste de l'archive lue par tar.
  const mem = memorySys((file, args) =>
    file === "/bin/tar" && args[0] === "-tvzf" ? { code: 0, stdout: "-rw-r--r-- 0/0 1 2026-10-25 10:00 public/index.php\n", stderr: "" } : { code: 0, stdout: "", stderr: "" },
  );
  const ops = siteOperations({ paths, domain: "kouzia.com", phpInstalled: () => ["8.3"], limitsEffective: () => true, httpStatus: async () => 404, sys: mem.sys });
  store = mailStore({ dir: mkdtempSync(join(tmpdir(), "kouzia-mails-")), now: () => clock++ });
  const probes = {
    alpine: () => "3.22.2",
    php: () => ["8.3"],
    service: async () => "running",
    cgroups: () => ({ result: "ok", checkedAt: null }),
    lastUpgrade: () => "2026-10-25",
    disk: () => null,
    memory: () => 3 * 1024 ** 3,
    sites: () => 0,
    tunnelId: () => "6ff42ae2-765d-4adf-8112-31c55c1551ef",
    now: () => Date.now(),
  } satisfies Probes;
  // Archives reçues (page d'attente) écrites sur un vrai disque temporaire.
  const disk = mkdtempSync(join(tmpdir(), "kouzia-php-mails-"));
  const sites = { ...ops, incomingFile: async (slug: string, nonce: string, kind?: "version" | "sql" | "sqlgz") => (await ops.incomingFile(slug, nonce, kind), join(disk, `${nonce}.tar.gz`)) };
  server = createAgent({ secret: SECRET, allowedIps: ["127.0.0.1"], probes, sites, mails: store });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const agent = new PhpAgentClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, secret: SECRET });
  hub = await buildTestHub({ phpAgent: agent, mailSender: async (config, message) => void sent.push({ config, message }) });
});
afterEach(async () => {
  await hub.app.close();
  await new Promise((resolve) => server.close(resolve));
});

const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  hub.app.inject({ method, url, headers: hub.headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function site(): Promise<string> {
  const res = await call("POST", "/api/sites", { kind: "PERSO", slug: "mytakumi", label: "MyTakumi", hosting: "php", php: {} });
  expect(res.statusCode, res.body).toBe(201);
  await settle(hub);
  return (res.json() as SiteDetail).id;
}
const capture = (raw = ORDER, to = ["client@exemple.fr", "cache@exemple.fr"]) => store.save("mytakumi", Buffer.from(raw), { from: "boutique@mytakumi.fr", to });
const smtp = (over: Record<string, unknown> = {}) =>
  call("PATCH", "/api/settings/smtp", { host: "smtp.exemple.fr", port: 587, security: "starttls", user: "hub@kouzia.com", password: "mot-de-passe-smtp", from: "hub@kouzia.com", to: "alexandre@kouzia.com", ...over });

describe("e-mails capturés : lecture", () => {
  it("liste décodée (destinataires d'origine, Cci compris) ; détail : texte, en-têtes, pièces jointes, contenu distant signalé", async () => {
    const id = await site();
    const meta = await capture();
    const list = (await call("GET", `/api/sites/${id}/php/mails`)).json() as PhpMailList;
    expect(list.mails).toEqual([expect.objectContaining({ id: meta.id, subject: "Commande n°42 confirmée", from: "MyTakumi <boutique@mytakumi.fr>", to: ["client@exemple.fr", "cache@exemple.fr"], attachments: 1 })]);
    expect(list.redirect).toEqual({ enabled: false, recipients: [] });
    expect(list.smtp).toEqual({ configured: false, to: null });

    const detail = (await call("GET", `/api/sites/${id}/php/mails/${meta.id}`)).json() as PhpMailDetail;
    expect(detail).toMatchObject({ subject: "Commande n°42 confirmée", hasHtml: true, remoteContent: true, text: "Merci pour votre commande." });
    expect(detail.headers.find((h) => h.name === "to")?.value).toContain("client@exemple.fr");
    expect(detail.attachmentsList.map((a) => [a.filename, a.inline])).toEqual(expect.arrayContaining([["facture.pdf", false]]));
    expect((await call("GET", `/api/sites/${id}/php/mails/0000000000000-00000000`)).statusCode).toBe(404);
    expect((await call("GET", `/api/sites/${id}/php/mails/..%2F..%2Fetc`)).statusCode).toBe(404);
  });

  it("HTML pour le cadre isolé : CSP sans script ni distant, sandbox, image intégrée en données ; distant seulement sur demande", async () => {
    const id = await site();
    const meta = await capture();
    const res = await call("GET", `/api/sites/${id}/php/mails/${meta.id}/html`);
    expect(res.statusCode).toBe(200);
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src data:;");
    expect(csp).not.toMatch(/script-src|https:/);
    expect(csp).toContain("sandbox allow-popups allow-popups-to-escape-sandbox");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.body).toContain(`src="data:image/png;base64,${PIXEL.toString("base64")}"`);
    expect(res.body).toContain('<base target="_blank">');
    const remote = await call("GET", `/api/sites/${id}/php/mails/${meta.id}/html?distant=1`);
    expect(String(remote.headers["content-security-policy"])).toContain("img-src data: https: http:");
    expect(String(remote.headers["content-security-policy"])).not.toContain("script-src");
  });

  it("pièce jointe et .eml : toujours en téléchargement, jamais affichés", async () => {
    const id = await site();
    const meta = await capture();
    const detail = (await call("GET", `/api/sites/${id}/php/mails/${meta.id}`)).json() as PhpMailDetail;
    const pdf = detail.attachmentsList.find((a) => a.filename === "facture.pdf")!;
    const piece = await call("GET", `/api/sites/${id}/php/mails/${meta.id}/pieces/${pdf.index}`);
    expect(piece.headers["content-type"]).toBe("application/octet-stream");
    expect(piece.headers["content-disposition"]).toContain('attachment; filename="facture.pdf"');
    expect(piece.body).toBe("%PDF-1.4 facture");
    expect((await call("GET", `/api/sites/${id}/php/mails/${meta.id}/pieces/99`)).statusCode).toBe(404);
    const eml = await call("GET", `/api/sites/${id}/php/mails/${meta.id}/eml`);
    expect(eml.headers["content-disposition"]).toContain(`mytakumi-${meta.id}.eml`);
    expect(eml.body).toBe(ORDER);
  });

  it("suppression d'un e-mail, puis de tous", async () => {
    const id = await site();
    const a = await capture();
    await capture();
    expect((await call("DELETE", `/api/sites/${id}/php/mails/${a.id}`)).statusCode).toBe(200);
    expect(((await call("GET", `/api/sites/${id}/php/mails`)).json() as PhpMailList).mails).toHaveLength(1);
    expect((await call("DELETE", `/api/sites/${id}/php/mails`)).json()).toEqual({ removed: 1 });
  });
});

describe("compte SMTP du hub", () => {
  it("mot de passe chiffré, jamais renvoyé ; vide = inchangé ; adresses contrôlées ; e-mail d'essai", async () => {
    const res = await smtp();
    expect(res.statusCode, res.body).toBe(200);
    const view = res.json() as SmtpSettings;
    expect(view).toEqual({ host: "smtp.exemple.fr", port: 587, security: "starttls", user: "hub@kouzia.com", passwordSet: true, from: "hub@kouzia.com", to: "alexandre@kouzia.com", configured: true });
    expect(JSON.stringify((await call("GET", "/api/settings/smtp")).json())).not.toContain("mot-de-passe-smtp");
    const stored = await prisma.hubSetting.findUniqueOrThrow({ where: { key: "smtp.password" } });
    expect(stored.value).not.toContain("mot-de-passe-smtp");
    // Champ vide : le mot de passe reste.
    expect(((await smtp({ password: "" })).json() as SmtpSettings).passwordSet).toBe(true);
    expect((await prisma.hubSetting.findUniqueOrThrow({ where: { key: "smtp.password" } })).value).toBe(stored.value);
    const bad = await smtp({ to: "pas-une-adresse" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ field: "to" });
    expect((await smtp({ host: "smtp exemple" })).statusCode).toBe(400);

    const test = await call("POST", "/api/settings/smtp/essai");
    expect(test.statusCode, test.body).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.config).toMatchObject({ host: "smtp.exemple.fr", password: "mot-de-passe-smtp" });
    expect(sent[0]!.message).toMatchObject({ from: "hub@kouzia.com", to: "alexandre@kouzia.com" });
  });
});

describe("remise des e-mails capturés", () => {
  it("« Envoyer à mon adresse » : refusé sans SMTP ; sinon vers mon adresse seule, origine dans l'objet et l'en-tête", async () => {
    const id = await site();
    const meta = await capture();
    const refused = await call("POST", `/api/sites/${id}/php/mails/${meta.id}/envoyer`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "smtp_unset" });
    expect(sent).toHaveLength(0);

    await smtp();
    const ok = await call("POST", `/api/sites/${id}/php/mails/${meta.id}/envoyer`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ sentTo: ["alexandre@kouzia.com"] });
    const m = sent[0]!.message;
    expect(m.to).toEqual(["alexandre@kouzia.com"]);
    expect(m.from).toBe("hub@kouzia.com");
    expect(m.replyTo).toBe("boutique@mytakumi.fr");
    expect(m.subject).toBe("[recette pour client@exemple.fr, cache@exemple.fr] Commande n°42 confirmée");
    expect(m.headers).toMatchObject({ "X-Kouzia-Original-To": "client@exemple.fr, cache@exemple.fr", "X-Kouzia-Site": "mytakumi.kouzia.com" });
    expect(JSON.stringify([m.to, m.cc ?? null, m.bcc ?? null])).not.toContain("client@exemple.fr");
    expect((m.attachments ?? []).map((a) => a.filename)).toEqual(expect.arrayContaining(["facture.pdf"]));
  });

  it("redirection : adresses contrôlées (10 au plus) ; seuls les nouveaux e-mails, une seule fois, vers les adresses autorisées", async () => {
    const id = await site();
    await smtp();
    const before = await capture();
    expect((await call("PATCH", `/api/sites/${id}/php/mails/redirection`, { recipients: ["ok@exemple.fr", "pas une adresse"] })).statusCode).toBe(400);
    const eleven = Array.from({ length: 11 }, (_, i) => `a${i}@exemple.fr`);
    expect((await call("PATCH", `/api/sites/${id}/php/mails/redirection`, { recipients: eleven })).statusCode).toBe(400);
    const set = await call("PATCH", `/api/sites/${id}/php/mails/redirection`, { enabled: true, recipients: ["Recette@Exemple.fr", "recette@exemple.fr", "client-test@exemple.fr"] });
    expect(set.json()).toEqual({ enabled: true, recipients: ["recette@exemple.fr", "client-test@exemple.fr"] });

    clock = Date.now() + 1000;
    const after = await capture();
    const deps = { services: hub.services, sender: hub.services.mailSender, limiter: new ForwardLimiter() };
    expect(await forwardNewMails(deps)).toBe(1);
    expect(sent.map((s) => s.message.to)).toEqual([["recette@exemple.fr", "client-test@exemple.fr"]]);
    expect(sent[0]!.message.subject).toContain("[recette pour client@exemple.fr, cache@exemple.fr]");
    // Déjà remis : pas deux fois ; l'arriéré d'avant l'option non plus.
    expect(await forwardNewMails(deps)).toBe(0);
    expect(before.id < after.id).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("débit : 30 par heure et par site au plus, le reste noté au journal ; SMTP en échec : repris au passage suivant", async () => {
    const id = await site();
    await smtp();
    await call("PATCH", `/api/sites/${id}/php/mails/redirection`, { enabled: true });
    clock = Date.now() + 1000;
    for (let i = 0; i < FORWARDS_PER_HOUR + 2; i++) await capture(ORDER.replace("Commande", `Commande ${i}`));
    const limiter = new ForwardLimiter();
    expect(await forwardNewMails({ services: hub.services, sender: hub.services.mailSender, limiter })).toBe(FORWARDS_PER_HOUR);
    const journal = await prisma.auditEvent.findMany({ where: { action: "site.php.mail.forward", result: "error" } });
    expect(journal.map((j) => j.detail).join(" ")).toContain("2 e-mail(s) non remis");

    // SMTP qui refuse : rien n'est marqué remis, le passage suivant reprend le même e-mail.
    sent.length = 0;
    await capture();
    let fail = true;
    const flaky = async (config: SmtpConfig, message: MailMessage) => {
      if (fail) throw Object.assign(new Error("refus"), { responseCode: 451 });
      sent.push({ config, message });
    };
    expect(await forwardNewMails({ services: hub.services, sender: flaky, limiter: new ForwardLimiter() })).toBe(0);
    fail = false;
    expect(await forwardNewMails({ services: hub.services, sender: flaky, limiter: new ForwardLimiter() })).toBe(1);
  });
});
