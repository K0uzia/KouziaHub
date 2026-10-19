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
  return { calls, dir: new HttpErpDirectory({ baseUrl: "http://203.0.113.50:3100/", secret: SECRET, fetch: fetchImpl, now }) };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("annuaire ERP par HTTP (fetch injecté)", () => {
  it("signe « horodatage.GET.chemin » en HMAC-SHA256 avec les en-têtes attendus", async () => {
    const { calls, dir } = erp(() => json({ clients: CLIENTS }));
    await dir.list();
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("http://203.0.113.50:3100/api/hub/clients");
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
      baseUrl: "http://203.0.113.50:3100",
      secret: SECRET,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(down.list()).rejects.toBeInstanceOf(ErpUnavailableError);
    await expect(erp(() => json({}, 500)).dir.list()).rejects.toBeInstanceOf(ErpUnavailableError);
    await expect(erp(() => json({ error: "x" })).dir.list()).rejects.toBeInstanceOf(ErpUnavailableError);
    await expect(erp(() => json({ clients: "x" })).dir.list()).rejects.toBeInstanceOf(ErpUnavailableError);
    await expect(erp(() => new Response("<html>", { status: 200 })).dir.list()).rejects.toBeInstanceOf(ErpUnavailableError);
  });

  it("écarte un client invalide seul, garde les autres, et ne journalise que le nombre", async () => {
    const warnings: string[] = [];
    const invalid = [
      { id: "v1", clientNumber: null, displayName: "", type: "B2B" },
      { id: "v2", clientNumber: null, displayName: "Nom secret".padEnd(301, "x"), type: "B2B" },
      { id: "v3", clientNumber: "N".repeat(65), displayName: "Numéro trop long", type: "B2B" },
      { id: "v4", clientNumber: null, displayName: "Type inconnu", type: "PARTICULIER" },
      { id: "../v5", clientNumber: null, displayName: "Identifiant invalide", type: "B2C" },
      "pas un objet",
    ];
    const dir = new HttpErpDirectory({
      baseUrl: "http://203.0.113.50:3100",
      secret: SECRET,
      fetch: (async () => json({ clients: [CLIENTS[0], ...invalid, CLIENTS[1]] })) as typeof fetch,
      warn: (m) => warnings.push(m),
    });
    expect((await dir.list()).map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("6 client(s) écarté(s)");
    for (const c of [...CLIENTS, ...invalid]) {
      if (typeof c === "object" && c.displayName) expect(warnings[0]).not.toContain(c.displayName.slice(0, 8));
    }
  });

  it("un client invalide lu seul vaut « inconnu », pas « ERP indisponible »", async () => {
    const warnings: string[] = [];
    const dir = new HttpErpDirectory({
      baseUrl: "http://203.0.113.50:3100",
      secret: SECRET,
      fetch: (async () => json({ client: { id: "c1", clientNumber: null, displayName: "", type: "B2B" } })) as typeof fetch,
      warn: (m) => warnings.push(m),
    });
    expect(await dir.get("c1")).toBeNull();
    expect(warnings).toEqual(["[erp] 1 client(s) écarté(s) : réponse de l'ERP invalide pour ces fiches"]);
  });

  it("annuaire factice : clients marqués « Exemple »", async () => {
    const clients = await new FakeErpDirectory().list();
    expect(clients.length).toBeGreaterThanOrEqual(10);
    expect(clients.every((c) => c.displayName.startsWith("Exemple "))).toBe(true);
  });
});
