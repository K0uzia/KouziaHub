// Déploiement contre un faux serveur Cloudflare (fetch injecté) : aucun appel réel.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyRequest } from "../../../apps/api/src/lib/monitor/core.js";
import { CRON, D1_NAME, DeployError, WORKER_NAME, deployVeille, parseEnv, splitSql, updateEnvText, type DeployDeps } from "../tools/deploy.js";
import { SCHEMA_FILE } from "../tools/bundle.js";

const TOKEN = "TokenDeDeploiement_0123456789abcdefABCDEF";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SHARED = "secret-partage-existant-0123456789-abcdef";
const VAPID = { VAPID_PUBLIC_KEY: "BPubliqueVapid" + "x".repeat(70), VAPID_PRIVATE_KEY: "PriveeVapid" + "y".repeat(32), VAPID_SUBJECT: "mailto:contact@kouzia.com" };
const API = "https://api.cloudflare.com/client/v4";

type Call = { method: string; url: string; auth: string | null; json: unknown; form: Record<string, { type: string; text: string; filename?: string }> | null };

/** Faux Cloudflare : comptes, sous-domaine, D1, scripts, secrets, planification ; et le Worker déployé. */
function fakeCloudflare(opts: { subdomain?: string | null; existingDb?: boolean; denied?: boolean; stateStatus?: number[] } = {}) {
  const calls: Call[] = [];
  const secretsSet: Record<string, string> = {};
  const stateStatus = [...(opts.stateStatus ?? [200])];
  const env = (result: unknown, status = 200, success = true) =>
    new Response(JSON.stringify({ success, errors: success ? [] : [{ code: 10000, message: "Authentication error" }], messages: [], result }), { status });

  const fetch: DeployDeps["fetch"] = async (input, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    let json: unknown = null;
    let form: Call["form"] = null;
    if (init.body instanceof FormData) {
      form = {};
      for (const [name, value] of init.body.entries()) {
        const blob = value as File;
        form[name] = { type: blob.type, text: await blob.text(), filename: blob.name };
      }
    } else if (typeof init.body === "string") {
      json = JSON.parse(init.body);
    }
    calls.push({ method, url: input, auth: headers.get("authorization"), json, form });

    if (input.startsWith(`https://${WORKER_NAME}.`)) {
      const status = stateStatus.length > 1 ? stateStatus.shift()! : stateStatus[0]!;
      const okSig = await verifyRequest(secretsSet.MONITOR_SHARED_SECRET ?? "", { timestamp: headers.get(TIMESTAMP_HEADER), signature: headers.get(SIGNATURE_HEADER) }, "GET", "/state", "", 1_792_000_000_000);
      if (status !== 200 || !okSig) return new Response("Not Found", { status: 404 });
      return new Response(JSON.stringify({ v: 1, now: 0, edgeSeenAt: null, hubSeenAt: null, observations: [], incidents: [] }));
    }
    if (opts.denied) return env(null, 403, false);
    const path = input.slice(API.length);
    const acct = `/accounts/${ACCOUNT}`;
    if (path === "/accounts") return env([{ id: ACCOUNT, name: "Kouzia" }]);
    if (path === `${acct}/workers/subdomain`) {
      return opts.subdomain === null ? env(null, 404, false) : env({ subdomain: opts.subdomain ?? "alexandre" });
    }
    if (path === `${acct}/d1/database?name=${D1_NAME}` && method === "GET") return env(opts.existingDb ? [{ uuid: "db-existante", name: D1_NAME }] : []);
    if (path === `${acct}/d1/database` && method === "POST") return env({ uuid: "db-nouvelle", name: D1_NAME });
    if (/\/d1\/database\/[^/]+\/query$/.test(path) && method === "POST") return env([{ results: [], success: true }]);
    if (path === `${acct}/workers/scripts/${WORKER_NAME}` && method === "PUT") return env({ id: WORKER_NAME });
    if (path === `${acct}/workers/scripts/${WORKER_NAME}/secrets` && method === "PUT") {
      const b = json as { name: string; text: string };
      secretsSet[b.name] = b.text;
      return env({ name: b.name, type: "secret_text" });
    }
    if (path === `${acct}/workers/scripts/${WORKER_NAME}/schedules` && method === "PUT") return env({ schedules: json });
    if (path === `${acct}/workers/scripts/${WORKER_NAME}/subdomain` && method === "POST") return env({ enabled: true });
    return env(null, 404, false);
  };
  return { fetch, calls, secretsSet };
}

function run(server: ReturnType<typeof fakeCloudflare>, envOverrides: Record<string, string> = {}) {
  const lines: string[] = [];
  const deps: DeployDeps = { fetch: server.fetch, log: (l) => lines.push(l), sleep: async () => undefined, now: () => 1_792_000_000_000, randomSecret: () => "secret-genere-par-le-test-0123456789abcdef" };
  const promise = deployVeille(
    { token: TOKEN, env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, MONITOR_SHARED_SECRET: SHARED, ...VAPID, ...envOverrides }, script: "export default {};", schemaSql: readFileSync(SCHEMA_FILE, "utf8") },
    deps,
  );
  return { promise, lines };
}

describe("déploiement de la veille (faux serveur)", () => {
  it("D1, schéma, script, secrets, planification, adresse, vérification signée", async () => {
    const server = fakeCloudflare();
    const { promise, lines } = run(server);
    const result = await promise;
    expect(result).toEqual({ workerUrl: `https://${WORKER_NAME}.alexandre.workers.dev`, databaseId: "db-nouvelle", envUpdates: { MONITOR_WORKER_URL: `https://${WORKER_NAME}.alexandre.workers.dev` } });

    const cfCalls = server.calls.filter((c) => c.url.startsWith(API));
    expect(cfCalls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    const route = (c: Call) => `${c.method} ${c.url.slice(API.length).replace(ACCOUNT, "{compte}")}`;
    const statements = splitSql(readFileSync(SCHEMA_FILE, "utf8"));
    expect(cfCalls.map(route)).toEqual([
      "GET /accounts/{compte}/workers/subdomain",
      `GET /accounts/{compte}/d1/database?name=${D1_NAME}`,
      "POST /accounts/{compte}/d1/database",
      ...statements.map(() => "POST /accounts/{compte}/d1/database/db-nouvelle/query"),
      `PUT /accounts/{compte}/workers/scripts/${WORKER_NAME}`,
      ...["MONITOR_SHARED_SECRET", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"].map(() => `PUT /accounts/{compte}/workers/scripts/${WORKER_NAME}/secrets`),
      `PUT /accounts/{compte}/workers/scripts/${WORKER_NAME}/schedules`,
      `POST /accounts/{compte}/workers/scripts/${WORKER_NAME}/subdomain`,
    ]);
    expect(cfCalls[2]!.json).toEqual({ name: D1_NAME });
    expect(statements.length).toBeGreaterThanOrEqual(8);
    expect((cfCalls[3]!.json as { sql: string }).sql).toMatch(/^CREATE TABLE IF NOT EXISTS targets/);

    const upload = cfCalls.find((c) => c.form)!;
    expect(Object.keys(upload.form!)).toEqual(["metadata", "index.js"]);
    expect(upload.form!.metadata!.type).toBe("application/json");
    expect(JSON.parse(upload.form!.metadata!.text)).toEqual({
      main_module: "index.js",
      compatibility_date: "2026-10-01",
      bindings: [{ type: "d1", name: "DB", id: "db-nouvelle" }],
      keep_bindings: ["secret_text"],
    });
    expect(upload.form!["index.js"]).toEqual({ type: "application/javascript+module", text: "export default {};", filename: "index.js" });

    expect(server.secretsSet).toEqual({ MONITOR_SHARED_SECRET: SHARED, ...VAPID });
    expect(cfCalls.find((c) => c.url.endsWith("/schedules"))!.json).toEqual([{ cron: CRON }]);
    expect(cfCalls.find((c) => c.url.endsWith("/subdomain") && c.method === "POST")!.json).toEqual({ enabled: true, previews_enabled: false });
    expect(server.calls.at(-1)!.url).toBe(`https://${WORKER_NAME}.alexandre.workers.dev/state`);

    // Aucun secret dans les sorties.
    const out = lines.join("\n");
    for (const s of [TOKEN, SHARED, ...Object.values(VAPID).slice(0, 2)]) expect(out).not.toContain(s);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("base existante réutilisée ; secret partagé absent : créé et renvoyé pour le .env", async () => {
    const server = fakeCloudflare({ existingDb: true });
    const { promise, lines } = run(server, { MONITOR_SHARED_SECRET: "" });
    const result = await promise;
    expect(result.databaseId).toBe("db-existante");
    expect(server.calls.some((c) => c.method === "POST" && c.url.endsWith("/d1/database"))).toBe(false);
    expect(result.envUpdates.MONITOR_SHARED_SECRET).toBe("secret-genere-par-le-test-0123456789abcdef");
    expect(server.secretsSet.MONITOR_SHARED_SECRET).toBe("secret-genere-par-le-test-0123456789abcdef");
    expect(lines.join("\n")).not.toContain("secret-genere-par-le-test");
  });

  it("compte sans adresse workers.dev : arrêt avant toute modification, avec la marche à suivre", async () => {
    const server = fakeCloudflare({ subdomain: null });
    await expect(run(server).promise).rejects.toThrow(/Workers et Pages.*sous-domaine/);
    expect(server.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("jeton refusé : message sur les droits, jeton jamais repris dans l'erreur", async () => {
    const server = fakeCloudflare({ denied: true });
    const err = await run(server).promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeployError);
    expect((err as Error).message).toMatch(/Workers Scripts > Edit et Account > D1 > Edit/);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("clés VAPID absentes : rien n'est envoyé, renvoi vers hubctl push-keys", async () => {
    const server = fakeCloudflare();
    await expect(run(server, { VAPID_PRIVATE_KEY: "" }).promise).rejects.toThrow(/hubctl push-keys/);
    expect(server.calls).toEqual([]);
  });

  it("le Worker met quelques essais à répondre : vérification répétée", async () => {
    const server = fakeCloudflare({ stateStatus: [404, 404, 200] });
    await run(server).promise;
    expect(server.calls.filter((c) => c.url.endsWith(".workers.dev/state"))).toHaveLength(3);
  });
});

describe(".env du hub", () => {
  it("lecture et mise à jour en place, valeurs dangereuses refusées", () => {
    const text = '# commentaire\nA="1"\nMONITOR_WORKER_URL=\nB=deux\n';
    expect(parseEnv(text)).toEqual({ A: "1", MONITOR_WORKER_URL: "", B: "deux" });
    expect(updateEnvText(text, { MONITOR_WORKER_URL: "https://x.workers.dev", NOUVEAU: "v" })).toBe(
      '# commentaire\nA="1"\nMONITOR_WORKER_URL="https://x.workers.dev"\nB=deux\nNOUVEAU="v"\n',
    );
    expect(() => updateEnvText(text, { A: 'x"y' })).toThrow(DeployError);
  });
});
