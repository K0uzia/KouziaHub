import { describe, expect, it } from "vitest";
import {
  contentHash,
  dnsDrift,
  dnsSnapshot,
  httpCheck,
  HTTP_MAX_BYTES,
  normalizeHtml,
  RdapClient,
  registrableDomain,
  tlsCheck,
  type DnsResolver,
  type PeerInfo,
} from "@/lib/monitor/checks.js";
import { isPrivateHost, measureSpeed } from "@/lib/monitor/speed.js";

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
function fakeFetch(route: Route) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return route(String(input), init);
  }) as typeof fetch;
  return { f, calls };
}

describe("contrôle HTTP", () => {
  it("suit les redirections à la main, sans dépasser 5, et mesure le temps", async () => {
    let t = 0;
    const { f, calls } = fakeFetch((url) => {
      t += 40;
      if (url === "http://a.fr/") return new Response(null, { status: 301, headers: { Location: "https://a.fr/" } });
      if (url === "https://a.fr/") return new Response(null, { status: 302, headers: { Location: "/accueil" } });
      return new Response("<h1>Bonjour</h1>", { status: 200 });
    });
    const r = await httpCheck("http://a.fr/", { fetch: f, keyword: "Bonjour", now: () => t });
    expect(r).toMatchObject({ ok: true, status: 200, reason: null, finalUrl: "https://a.fr/accueil" });
    expect(r.ms).toBe(120);
    expect(calls.every((c) => c.init?.redirect === "manual")).toBe(true);
  });

  it("trop de redirections, statut d'erreur, mot-clé absent, délai dépassé, connexion impossible", async () => {
    const loop = fakeFetch((url) => new Response(null, { status: 302, headers: { Location: `${url}x` } }));
    expect(await httpCheck("https://a.fr/", { fetch: loop.f })).toMatchObject({ ok: false, reason: "trop de redirections" });
    expect(loop.calls).toHaveLength(6);
    expect(await httpCheck("https://a.fr/", { fetch: fakeFetch(() => new Response("x", { status: 503 })).f })).toMatchObject({ ok: false, status: 503, reason: "statut 503" });
    expect(await httpCheck("https://a.fr/", { fetch: fakeFetch(() => new Response("autre")).f, keyword: "Bonjour" })).toMatchObject({ ok: false, reason: "mot-clé absent" });
    const timeout = fakeFetch(() => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    expect(await httpCheck("https://a.fr/", { fetch: timeout.f })).toMatchObject({ ok: false, status: null, reason: "délai dépassé" });
    const refused = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect(await httpCheck("https://a.fr/", { fetch: refused.f })).toMatchObject({ ok: false, reason: "connexion impossible" });
  });

  it("une redirection 3xx sans Location est un succès (statut final 3xx)", async () => {
    expect(await httpCheck("https://a.fr/", { fetch: fakeFetch(() => new Response(null, { status: 304 })).f })).toMatchObject({ ok: true, status: 304 });
  });

  it("corps plafonné à 2 Mio", async () => {
    const big = "a".repeat(HTTP_MAX_BYTES + 500_000) + "FIN";
    const r = await httpCheck("https://a.fr/", { fetch: fakeFetch(() => new Response(big)).f, wantBody: true, keyword: "FIN" });
    expect(r.body!.length).toBe(HTTP_MAX_BYTES);
    expect(r.reason).toBe("mot-clé absent");
  });
});

describe("certificat", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  const peer = (over: Partial<PeerInfo> & { validTo?: string; cn?: string } = {}): PeerInfo => ({
    cert: {
      valid_to: over.validTo ?? "Dec 31 12:00:00 2026 GMT",
      issuer: { O: "Let's Encrypt", CN: "R11" } as PeerInfo["cert"]["issuer"],
      subject: { CN: over.cn ?? "a.fr" } as PeerInfo["cert"]["subject"],
      subjectaltname: `DNS:${over.cn ?? "a.fr"}, DNS:www.${over.cn ?? "a.fr"}`,
    },
    authorized: over.authorized ?? true,
    authorizationError: over.authorizationError ?? null,
  });

  it("valide : échéance, jours restants, émetteur", async () => {
    const r = await tlsCheck("www.a.fr", async () => peer(), now);
    expect(r).toMatchObject({ ok: true, issuer: "Let's Encrypt", error: null, daysLeft: 74 });
    expect(r.validTo).toBe("2026-12-31T12:00:00.000Z");
  });

  it("expiré, nom non couvert, chaîne non reconnue, connexion impossible", async () => {
    expect((await tlsCheck("a.fr", async () => peer({ validTo: "Oct 01 00:00:00 2026 GMT" }), now)).error).toBe("certificat expiré");
    expect((await tlsCheck("b.fr", async () => peer(), now)).error).toBe("nom non couvert par le certificat");
    expect((await tlsCheck("a.fr", async () => peer({ authorized: false, authorizationError: "SELF_SIGNED_CERT_IN_CHAIN" }), now)).error).toMatch(/non reconnu/);
    const down = await tlsCheck("a.fr", async () => Promise.reject(new Error("ECONNREFUSED")), now);
    expect(down).toMatchObject({ ok: false, validTo: null, error: expect.stringMatching(/^connexion TLS impossible/) });
  });
});

describe("échéance du domaine (RDAP)", () => {
  const bootstrap = { services: [[["fr"], ["https://rdap.nic.fr/"]], [["com", "net"], ["https://rdap.verisign.com/com/v1/"]]] };

  it("serveur trouvé par l'amorce IANA (gardée en cache), date d'expiration et bureau d'enregistrement", async () => {
    const { f, calls } = fakeFetch((url) => {
      if (url === "https://data.iana.org/rdap/dns.json") return Response.json(bootstrap);
      if (url === "https://rdap.nic.fr/domain/client.fr")
        return Response.json({
          events: [{ eventAction: "registration", eventDate: "2020-01-01T00:00:00Z" }, { eventAction: "expiration", eventDate: "2027-03-01T00:00:00Z" }],
          entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Registrar Exemple"]]] }],
        });
      return new Response("", { status: 404 });
    });
    const rdap = new RdapClient({ fetch: f });
    expect(await rdap.lookup("www.client.fr")).toEqual({ expiresAt: "2027-03-01T00:00:00.000Z", registrar: "Registrar Exemple" });
    await rdap.lookup("client.fr");
    expect(calls.filter((c) => c.url.includes("iana")).length).toBe(1);
  });

  it("échéance absente ou extension inconnue : inconnue", async () => {
    const { f } = fakeFetch((url) => (url.includes("iana") ? Response.json(bootstrap) : Response.json({ events: [] })));
    const rdap = new RdapClient({ fetch: f });
    expect(await rdap.lookup("site.com")).toEqual({ expiresAt: null, registrar: null });
    expect(await rdap.lookup("site.zz")).toEqual({ expiresAt: null, registrar: null });
    expect(registrableDomain("a.b.client.fr")).toBe("client.fr");
  });
});

describe("DNS", () => {
  const resolver = (over: Partial<Record<keyof DnsResolver, unknown>> = {}): DnsResolver => {
    const nodata = () => Promise.reject(Object.assign(new Error("x"), { code: "ENODATA" }));
    return {
      resolve4: async () => (over.resolve4 as string[]) ?? ["192.0.2.2", "192.0.2.1"],
      resolve6: nodata,
      resolveCname: nodata,
      resolveNs: async () => ["NS2.Exemple.net.", "ns1.exemple.net"],
      resolveMx: async () => [{ priority: 10, exchange: "mx.exemple.net" }],
    };
  };

  it("instantané trié et normalisé ; ENODATA donne une liste vide", async () => {
    expect(await dnsSnapshot("www.client.fr", resolver())).toEqual({
      A: ["192.0.2.1", "192.0.2.2"],
      AAAA: [],
      CNAME: [],
      NS: ["ns1.exemple.net", "ns2.exemple.net"],
      MX: ["10 mx.exemple.net"],
    });
  });

  it("écart par type d'enregistrement", async () => {
    const ref = await dnsSnapshot("a.fr", resolver());
    const now = await dnsSnapshot("a.fr", resolver({ resolve4: ["198.51.100.7"] }));
    expect(dnsDrift(ref, now)).toEqual(["A"]);
    expect(dnsDrift(ref, ref)).toEqual([]);
  });

  it("erreur de résolution autre qu'une absence : remontée", async () => {
    const r = { ...resolver(), resolve4: () => Promise.reject(Object.assign(new Error("x"), { code: "ETIMEOUT" })) };
    await expect(dnsSnapshot("a.fr", r)).rejects.toThrow();
  });
});

describe("contenu de l'accueil", () => {
  it("même empreinte malgré nonces, jetons, dates et horodatages", () => {
    const a = '<html><script nonce="abc">x=1</script><meta name="csrf-token" content="t1"><p>Mis à jour le 2026-10-18T10:00:00Z</p><img src="/a.png?v=123"><!-- 1700000000000 --></html>';
    const b = '<html><script nonce="zzz">x=2</script><meta name="csrf-token" content="t2"><p>Mis à jour le 2026-10-19T11:30:00Z</p><img src="/a.png?v=456"></html>';
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash(a)).not.toBe(contentHash(a.replace("Mis à jour", "Modifié")));
    expect(normalizeHtml("<p>\n  a   b </p>")).toBe("<p> a b </p>");
  });
});

describe("vitesse", () => {
  it("adresses du réseau local et de la machine refusées", () => {
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.10", "169.254.1.1", "[::1]", "fd00::1", "fe80::1", "box.lan", "proxmox.local"]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ["client.fr", "203.0.113.5", "8.8.8.8", "cdn.exemple.com"]) expect(isPrivateHost(h), h).toBe(false);
  });

  it("sans Chromium : indisponible, proprement", async () => {
    expect(await measureSpeed("https://client.fr/", { chromiumPath: null })).toEqual({ available: false, reason: expect.stringMatching(/Chromium absent/) });
  });
});
