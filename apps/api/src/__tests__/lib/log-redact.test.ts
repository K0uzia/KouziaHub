import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { logSerializers, redactUnknownUrl, redactUrl } from "@/lib/log-redact.js";

// Journal des requêtes : un jeton glissé dans un lien mal tapé (404) ne part jamais en clair.
const TOKEN = "eyJhbGciOiJIUzI1NiJ9abcdefSECRETtoken";

describe("journal des requêtes sans route (404)", () => {
  it("ni requête après « ? », ni segment qui ressemble à un jeton", () => {
    expect(redactUnknownUrl(`/reinit/${TOKEN}?next=/x&token=${TOKEN}`)).toBe("/reinit/[masqué]?[masqué]");
    expect(redactUnknownUrl("/sites/inconnu")).toBe("/sites/inconnu");
    expect(redactUnknownUrl("/a/b?c=1")).toBe("/a/b?[masqué]");
    expect(redactUnknownUrl(undefined)).toBe("");
    // Route connue : les paramètres non sensibles restent lisibles.
    expect(redactUrl("/api/sites/x/php/journaux/php?lignes=200")).toBe("/api/sites/x/php/journaux/php?lignes=200");
  });

  it("vrai routeur Fastify : 404 masquée dans le journal, route connue lisible", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const app = Fastify({ logger: { level: "info", stream, serializers: logSerializers } });
    app.get("/api/ok", async () => ({ ok: true }));
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "Not found" }));
    await app.ready();
    expect((await app.inject({ method: "GET", url: `/connexion/${TOKEN}?code=${TOKEN}&autre=${TOKEN}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/ok?page=2" })).statusCode).toBe(200);
    await app.close();
    const log = lines.join("\n");
    expect(log).not.toContain(TOKEN);
    expect(log).toContain('"url":"/connexion/[masqué]?[masqué]"');
    expect(log).toContain('"url":"/api/ok?page=2"');
  });
});
