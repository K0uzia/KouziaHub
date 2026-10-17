import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeErpDirectory } from "@/lib/erp/fake.js";
import { HttpErpDirectory } from "@/lib/erp/http.js";
import { ErpUnavailableError } from "@/lib/erp/types.js";

const SECRET = "secret-partage-de-test";
const CLIENTS = [
  { id: "c1", clientNumber: "CLI-0001", displayName: "Élodie Durand", type: "B2C" },
  { id: "c2", clientNumber: "CLI-0002", displayName: "Atelier Bois", type: "B2B" },
];

type Call = { url: string; headers: Headers; method: string };

function erp(handler: (call: Call) => Response, now = () => 1_760_000_000_000) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), headers: new Headers(init?.headers), method: init?.method ?? "GET" };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, dir: new HttpErpDirectory({ baseUrl: "http://10.0.0.50:3000/", secret: SECRET, fetch: fetchImpl, now }) };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("annuaire ERP par HTTP (fetch injecté)", () => {
  it("signe « horodatage.GET.chemin » en HMAC-SHA256 avec les en-têtes attendus", async () => {
    const { calls, dir } = erp(() => json({ clients: CLIENTS }));
    await dir.list();
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("http://10.0.0.50:3000/api/hub/clients");
    expect(call.method).toBe("GET");
    const ts = call.headers.get("x-kouzia-hub-timestamp");
    expect(ts).toBe("1760000000");
    const expected = `sha256=${createHmac("sha256", SECRET).update(`${ts}.GET./api/hub/clients`).digest("hex")}`;
    expect(call.headers.get("x-kouzia-hub-signature")).toBe(expected);
  });

  it("garde la liste en cache, filtre sans accent ni casse, et relit après expiration", async () => {
    let t = 1_760_000_000_000;
    const { calls, dir } = erp(() => json({ clients: CLIENTS }), () => t);
    expect((await dir.list("elodie")).map((c) => c.id)).toEqual(["c1"]);
    expect((await dir.list("cli-0002")).map((c) => c.id)).toEqual(["c2"]);
    expect(await dir.get("c2")).toMatchObject({ displayName: "Atelier Bois" });
    expect(calls).toHaveLength(1);
    t += 6 * 60_000;
    await dir.list();
    expect(calls).toHaveLength(2);
  });

  it("lit un client par son identifiant (chemin signé) et renvoie null sur 404", async () => {
    const { calls, dir } = erp((call) => (call.url.endsWith("/c1") ? json({ client: CLIENTS[0] }) : json({ error: "Not found" }, 404)));
    expect(await dir.get("c1")).toMatchObject({ id: "c1" });
    expect(await dir.get("c9")).toBeNull();
    const ts = calls[0]!.headers.get("x-kouzia-hub-timestamp");
    expect(calls[0]!.headers.get("x-kouzia-hub-signature")).toBe(
      `sha256=${createHmac("sha256", SECRET).update(`${ts}.GET./api/hub/clients/c1`).digest("hex")}`,
    );
  });

  it("n'appelle pas l'ERP pour un identifiant invalide", async () => {
    const { calls, dir } = erp(() => json({}));
    expect(await dir.get("../admin")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("ERP injoignable, en erreur ou illisible : ErpUnavailableError", async () => {
    const down = new HttpErpDirectory({
      baseUrl: "http://10.0.0.50:3000",
      secret: SECRET,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(down.list()).rejects.toBeInstanceOf(ErpUnavailableError);
    await expect(erp(() => json({}, 500)).dir.list()).rejects.toBeInstanceOf(ErpUnavailableError);
    await expect(erp(() => json({ clients: [{ id: "x" }] })).dir.list()).rejects.toBeInstanceOf(ErpUnavailableError);
  });

  it("annuaire factice : clients marqués démonstration", async () => {
    const clients = await new FakeErpDirectory().list();
    expect(clients.length).toBeGreaterThanOrEqual(10);
    expect(clients.every((c) => c.displayName.startsWith("Démo"))).toBe(true);
  });
});
