import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PhpServerStatus } from "@/contract.js";
import { PhpAgentClient, PhpAgentUnavailableError, phpAgentFromEnv, signAgentRequest, signAgentResponse } from "@/lib/php-agent/client.js";
import { createAgent, signRequest, signResponse, type Probes } from "../../../../../scripts/php-ct/agent/agent.mjs";
import { resetDb } from "../helpers/db.js";
import { buildTestHub } from "../helpers/hub.js";

// Agent du CT des sites PHP (docs/cadrage.md, section 11.1) : le vrai agent (scripts/php-ct/agent/agent.mjs),
// lancé ici sur 127.0.0.1 avec des sondes simulées, face au vrai client du hub.
const SECRET = "s".repeat(48);
let clock = Date.parse("2026-10-24T12:00:00Z");

const probes: Probes = {
  alpine: () => "3.22.2",
  php: () => ["8.3"],
  service: async (name) => (name === "cloudflared" ? "stopped" : "running"),
  cgroups: () => ({ result: "ok", checkedAt: "2026-10-24 11:50" }),
  lastUpgrade: () => "2026-10-24",
  disk: () => ({ freeBytes: 20e9, totalBytes: 30e9 }),
  sites: () => 0,
  tunnelId: () => null,
  now: () => clock,
};

let server: Server;
let base: string;
const lines: string[] = [];

async function start(allowedIps = ["127.0.0.1"]) {
  server = createAgent({ secret: SECRET, allowedIps, probes, log: (l) => lines.push(l) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  clock = Date.parse("2026-10-24T12:00:00Z");
  lines.length = 0;
  await start();
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const client = (over: Partial<ConstructorParameters<typeof PhpAgentClient>[0]> = {}) => new PhpAgentClient({ baseUrl: base, secret: SECRET, now: () => clock, ...over });

describe("protocole de l'agent des sites PHP", () => {
  it("même signature des deux côtés (requête et réponse)", () => {
    expect(signAgentRequest(SECRET, "1792800000", "a".repeat(32), "get", "/v1/etat", "")).toBe(signRequest(SECRET, "1792800000", "a".repeat(32), "GET", "/v1/etat", ""));
    expect(signAgentRequest(SECRET, "1", "b".repeat(32), "POST", "/v1/x", '{"é":1}')).toBe(signRequest(SECRET, "1", "b".repeat(32), "POST", "/v1/x", '{"é":1}'));
    expect(signAgentResponse(SECRET, "c".repeat(32), 200, "{}")).toBe(signResponse(SECRET, "c".repeat(32), 200, "{}"));
  });

  it("état lu et vérifié ; journal sans secret ni en-tête", async () => {
    const state = await client().state();
    expect(state).toMatchObject({ alpine: "3.22.2", php: ["8.3"], services: { nginx: "running", tunnel: "stopped" }, cgroups: { result: "ok" }, sites: 0 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/127\.0\.0\.1 GET \/v1\/etat 200$/);
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("refus : autre secret, horloge décalée, adresse non autorisée, opération inconnue", async () => {
    await expect(client({ secret: "x".repeat(48) }).state()).rejects.toThrow(/signature refusée/);
    await expect(client({ now: () => clock - 120_000 }).state()).rejects.toThrow(/signature refusée/);
    await new Promise((resolve) => server.close(resolve));
    await start(["10.0.0.5"]);
    await expect(client().state()).rejects.toThrow(/pas autorisée/);
    await new Promise((resolve) => server.close(resolve));
    await start();
    const unknown = (client() as unknown as { request(m: string, p: string): Promise<unknown> }).request("GET", "/v1/exec");
    await expect(unknown).rejects.toThrow(/opération refusée \(404\)/);
  });

  it("une requête signée ne sert qu'une fois (rejeu refusé)", async () => {
    const ts = String(Math.floor(clock / 1000));
    const nonce = "d".repeat(32);
    const headers = { "x-kouzia-hub-timestamp": ts, "x-kouzia-hub-nonce": nonce, "x-kouzia-hub-signature": signAgentRequest(SECRET, ts, nonce, "GET", "/v1/etat", "") };
    expect((await fetch(`${base}/v1/etat`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/v1/etat`, { headers })).status).toBe(401);
  });

  it("réponse forgée (sans la bonne signature) : refusée par le hub", async () => {
    const forged: typeof fetch = async () => new Response(JSON.stringify({ sites: 99 }), { status: 200, headers: { "x-kouzia-agent-signature": "sha256=00" } });
    await expect(client({ fetch: forged }).state()).rejects.toBeInstanceOf(PhpAgentUnavailableError);
  });

  it("configuration : URL sans secret ou mal formée refusée ; rien posé : pas de serveur PHP", () => {
    expect(phpAgentFromEnv({})).toBeNull();
    expect(() => phpAgentFromEnv({ PHP_AGENT_URL: "http://192.168.1.40:8790" })).toThrow(/PHP_AGENT_SECRET/);
    expect(() => phpAgentFromEnv({ PHP_AGENT_URL: "https://php.kouzia.com", PHP_AGENT_SECRET: SECRET })).toThrow(/http:\/\/<IP/);
    expect(phpAgentFromEnv({ PHP_AGENT_URL: "http://192.168.1.40:8790", PHP_AGENT_SECRET: SECRET })).toBeInstanceOf(PhpAgentClient);
  });
});

describe("route /api/php/serveur", () => {
  it("non installé, joignable, puis injoignable", async () => {
    await resetDb();
    const get = async (hub: Awaited<ReturnType<typeof buildTestHub>>) =>
      (await hub.app.inject({ method: "GET", url: "/api/php/serveur", headers: hub.headers })).json() as PhpServerStatus;

    let hub = await buildTestHub();
    expect(await get(hub)).toEqual({ configured: false });
    await hub.app.close();

    hub = await buildTestHub({ phpAgent: client() });
    const ok = await get(hub);
    expect(ok).toMatchObject({ configured: true, reachable: true, state: { php: ["8.3"] } });
    expect((await hub.app.inject({ method: "GET", url: "/api/php/serveur" })).statusCode).toBe(401);
    await hub.app.close();

    hub = await buildTestHub({ phpAgent: client({ secret: "y".repeat(48) }) });
    expect(await get(hub)).toEqual({ configured: true, reachable: false, error: expect.stringMatching(/signature refusée/) });
    await hub.app.close();
  });
});
