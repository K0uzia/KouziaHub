import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { makeSmtpSender, sendFailure, type SmtpConfig } from "@/lib/mailer.js";

// Envoi SMTP du hub (lot P5) : délais courts et cause dite en clair. Vrais serveurs locaux, aucun réseau extérieur.
const QUICK = { connectionMs: 400, greetingMs: 400, socketMs: 600, dnsMs: 1000, totalMs: 3000 };
const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

async function listen(onSocket: (s: Socket) => void): Promise<number> {
  const server = createServer((s) => {
    sockets.push(s);
    s.on("error", () => {});
    onSocket(s);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}
const config = (port: number, over: Partial<SmtpConfig> = {}): SmtpConfig => ({
  host: "127.0.0.1",
  port,
  security: "ssl",
  user: "contact@kouzia.com",
  password: "mot-de-passe-secret",
  from: "contact@kouzia.com",
  to: "alexandre@kouzia.com",
  ...over,
});
const failure = async (cfg: SmtpConfig) => {
  const started = Date.now();
  try {
    await makeSmtpSender(QUICK)(cfg, { from: cfg.from, to: cfg.to, subject: "essai", text: "essai" });
  } catch (err) {
    return { message: sendFailure(err, cfg), ms: Date.now() - started };
  }
  throw new Error("envoi réussi : inattendu");
};

describe("envoi SMTP : cause en clair et réponse rapide", () => {
  it("port fermé : connexion refusée", async () => {
    const port = await listen(() => {});
    await new Promise((r) => servers.pop()!.close(r));
    const r = await failure(config(port));
    expect(r.message).toBe(`Connexion refusée par 127.0.0.1:${port} : port fermé ou mauvais port (465 = SSL, 587 = STARTTLS).`);
  });

  it("serveur muet (sortie filtrée, accueil jamais reçu) : délai dit, bien avant les 100 s du tunnel", async () => {
    const port = await listen(() => {});
    const r = await failure(config(port, { security: "starttls" }));
    expect(r.message).toMatch(/^Pas de réponse de 127\.0\.0\.1:\d+ dans le délai/);
    expect(r.ms).toBeLessThan(2500);
  });

  it("port en clair réglé en SSL : échec TLS, avec le rappel des ports", async () => {
    const port = await listen((s) => s.write("220 smtp.exemple ESMTP\r\n"));
    const r = await failure(config(port));
    expect(r.message).toMatch(/^Échec TLS avec 127\.0\.0\.1:\d+ : chiffrement inadapté au port \(465 = SSL, 587 = STARTTLS\)/);
  });

  it("nom introuvable : DNS", async () => {
    const r = await failure(config(465, { host: "hote-inexistant.invalid" }));
    expect(r.message).toBe("Serveur SMTP introuvable (DNS) : « hote-inexistant.invalid » ne se résout pas depuis le hub.");
  });

  it("authentification refusée : code SMTP ; ni identifiant ni mot de passe dans le message", () => {
    const cfg = config(465);
    const auth = Object.assign(new Error("Invalid login: 535 5.7.8 Error: authentication failed for contact@kouzia.com"), { code: "EAUTH", responseCode: 535 });
    expect(sendFailure(auth, cfg)).toBe("Authentification refusée par 127.0.0.1:465 (code 535) : identifiant ou mot de passe.");
    const refused = Object.assign(new Error("refus"), { responseCode: 550, response: "550 contact@kouzia.com mot-de-passe-secret refusé" });
    const text = sendFailure(refused, cfg);
    expect(text).toContain("code 550");
    expect(text).not.toContain("mot-de-passe-secret");
    expect(text).not.toContain("contact@kouzia.com");
    expect(sendFailure(Object.assign(new Error("x"), { code: "ETOTAL" }), cfg)).toMatch(/^Pas de réponse complète de 127\.0\.0\.1:465 en 45 s/);
  });
});
