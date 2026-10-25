import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PhpAgentClient, PhpAgentOpError, signAgentRequestHash } from "@/lib/php-agent/client.js";
import { createAgent, MAX_UPLOAD_BYTES } from "../../../../../scripts/php-ct/agent/agent.mjs";

// Transport du client de l'agent PHP (node:http, sans délai caché) : chaque échec dit sa vraie cause, au lieu de
// tout ranger en « injoignable » (publication de MyTakumi, 25/10/2026).
const SECRET = "s".repeat(48);
let server: Server | null = null;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe("transport du client de l'agent PHP : causes distinguées", () => {
  it("délai de l'opération dépassé : « pas de réponse en N s », pas « injoignable »", async () => {
    const base = await listen(() => undefined);
    const client = new PhpAgentClient({ baseUrl: base, secret: SECRET, timeoutMs: 300 });
    await expect(client.state()).rejects.toThrow("Serveur des sites PHP : pas de réponse en 0 s (GET /v1/etat).");
  });

  it("port fermé : connexion refusée (agent arrêté ou pare-feu)", async () => {
    const base = await listen(() => undefined);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    await expect(new PhpAgentClient({ baseUrl: base, secret: SECRET }).state()).rejects.toThrow(/connexion refusée \(agent arrêté, ou port fermé/);
  });

  it("connexion coupée par l'agent pendant l'échange : dit comme tel", async () => {
    const base = await listen((req) => req.socket.destroy());
    await expect(new PhpAgentClient({ baseUrl: base, secret: SECRET }).state()).rejects.toThrow(/connexion coupée pendant l'échange \(GET \/v1\/etat\)/);
  });

  it("réponse lente (au-delà de ce que fetch tolérerait sans réglage) : attendue jusqu'au délai de l'opération", async () => {
    // Le serveur répond après 1,2 s : le délai de l'opération (5 s) seul compte.
    const base = await listen((_req, res) => setTimeout(() => res.writeHead(401).end("{}"), 1200));
    await expect(new PhpAgentClient({ baseUrl: base, secret: SECRET, timeoutMs: 5000 }).state()).rejects.toThrow(/signature refusée/);
  });

  it("agent : envoi annoncé au-delà du plafond refusé (413) AVANT d'être reçu, message lisible côté hub", async () => {
    const agent = createAgent({ secret: SECRET, allowedIps: ["127.0.0.1"], sites: { incomingFile: async () => join(tmpdir(), "jamais.tar.gz") } });
    server = agent;
    await new Promise<void>((resolve) => agent.listen(0, "127.0.0.1", resolve));
    const port = (agent.address() as AddressInfo).port;
    const path = "/v1/sites/mytakumi/versions/2";
    const sha = "a".repeat(64);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString("hex");
    const status = await new Promise<{ code: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: "PUT",
          headers: {
            "content-type": "application/gzip",
            "content-length": String(MAX_UPLOAD_BYTES + 1),
            "x-kouzia-hub-content-sha256": sha,
            "x-kouzia-hub-timestamp": timestamp,
            "x-kouzia-hub-nonce": nonce,
            "x-kouzia-hub-signature": signAgentRequestHash(SECRET, timestamp, nonce, "PUT", path, sha),
          },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c)).on("end", () => resolve({ code: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.write("x");
    });
    expect(status.code).toBe(413);
    expect(JSON.parse(status.body).error).toBe(`Envoi trop lourd : ${Math.round((MAX_UPLOAD_BYTES + 1) / 1024 / 1024)} Mio, 1024 Mio au plus.`);

    // Même refus vu par le client du hub : erreur d'opération avec le message de l'agent (pas « injoignable »).
    const dir = mkdtempSync(join(tmpdir(), "kouzia-transport-"));
    writeFileSync(join(dir, "v.tar.gz"), "x");
    const client = new PhpAgentClient({ baseUrl: `http://127.0.0.1:${port}`, secret: SECRET });
    const err = await client.sendVersion("mytakumi", 2, { file: join(dir, "v.tar.gz"), sha256: sha }).catch((e: unknown) => e);
    // Petit fichier : reçu puis refusé pour empreinte différente, réponse signée et lisible.
    expect(err).toBeInstanceOf(PhpAgentOpError);
    expect((err as Error).message).toMatch(/Serveur des sites PHP : /);
  });
});
