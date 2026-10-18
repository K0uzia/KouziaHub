import { describe, expect, it } from "vitest";
import { HttpVeilleClient } from "../../../apps/api/src/lib/monitor/worker-client.js";
import type { Deps } from "../src/env.js";
import { handleFetch } from "../src/http.js";
import { BASE, SECRET, makeD1, makeEnv, makeNet } from "./helpers.js";

// Le vrai client du hub parle au vrai Worker, sans réseau : la requête construite par l'un est
// traitée par l'autre. Vérifie que signature, chemins et corps concordent des deux côtés.
function wire(now: number) {
  const { db } = makeD1();
  const env = makeEnv(db);
  const deps: Deps = { now: () => now, fetch: makeNet().fetch };
  const seen: string[] = [];
  const fetchToWorker = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push(`${req.method} ${new URL(req.url).pathname}${new URL(req.url).search}`);
    return handleFetch(req, env, deps);
  }) as typeof fetch;
  const client = (secret = SECRET) =>
    new HttpVeilleClient({ url: "https://kouzia-veille.example.workers.dev", secret, fetch: fetchToWorker, now: () => now });
  return { client, seen };
}

describe("interopérabilité hub et Worker", () => {
  it("sync, report puis state : acceptés de bout en bout, battement du hub visible", async () => {
    const { client, seen } = wire(BASE);
    const hub = client();
    await hub.sync({ targets: [{ id: "t1", label: "alpha.kouzia.com", url: "https://alpha.kouzia.com/", keyword: null }], subscriptions: [] });
    await hub.report({
      at: BASE,
      observations: [{ targetId: "t1", observer: "hub", at: BASE, ok: true, status: 200, ms: 90, reason: null }],
    });
    const state = await hub.state(0);
    expect(state.v).toBe(1);
    expect(state.hubSeenAt).toBe(BASE);
    expect(seen).toEqual(["POST /sync", "POST /report", "GET /state?since=0"]);
  });

  it("un autre secret est refusé par le Worker (404), le client le signale", async () => {
    const { client } = wire(BASE);
    await expect(client("autre-secret-de-test-0123456789ab").state(0)).rejects.toThrow();
  });
});
