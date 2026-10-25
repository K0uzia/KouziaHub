// Garde réseau de la surveillance (SSRF) et lancement de Chromium pour la mesure de vitesse.
// Aucun DNS ni réseau extérieur : résolveurs et connecteurs injectés, serveurs sur 127.0.0.1.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  guardedFetch,
  httpCheck,
  isPrivateAddress,
  isPrivateHost,
  makeTlsConnector,
  pinnedRequest,
  resolvePublic,
  tlsCheck,
  type HostLookup,
  type PinnedConnect,
  type ResolvedAddress,
} from "@/lib/monitor/checks.js";
import { portLaunchArgs, startChromium, startForCdp, stopChild, type Browser, type SpawnBrowser } from "@/lib/chromium.js";
import { measureSpeed, speedLauncher, speedRequestAllowed, speedStatus } from "@/lib/monitor/speed.js";
import { resolveChromium } from "@/lib/thumbnails.js";

const PUBLIC = "203.0.113.10";
const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });

/** Résolveur factice : une table par nom, appels comptés. */
function fakeLookup(table: Record<string, string[] | ((call: number) => string[])>) {
  const calls: string[] = [];
  const lookup: HostLookup = async (host) => {
    calls.push(host);
    const entry = table[host];
    const list = typeof entry === "function" ? entry(calls.filter((h) => h === host).length) : (entry ?? []);
    return list.map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 }));
  };
  return { lookup, calls };
}

/** Connecteur factice : enregistre l'URL et l'adresse vérifiée, répond selon l'URL. */
function fakeConnect(route: (url: string) => Response) {
  const calls: Array<{ url: string; address: string }> = [];
  const connect: PinnedConnect = async (url, _init, pinned) => {
    calls.push({ url: url.toString(), address: pinned.address });
    return route(url.toString());
  };
  return { connect, calls };
}

const redirectTo = (location: string) => new Response(null, { status: 302, headers: { Location: location } });

describe("adresses privées", () => {
  it("plages refusées, IPv4 mappée vérifiée comme IPv4", () => {
    const refused = [
      "127.0.0.1", "127.255.0.9", "0.0.0.0", "0.1.2.3", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
      "100.64.0.1", "100.127.255.254", "224.0.0.1", "239.1.1.1", "255.255.255.255", "198.18.0.1", "192.0.0.8",
      "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "febf::1", "ff02::1",
      "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:192.168.1.1", "::ffff:c0a8:101", "0:0:0:0:0:ffff:10.0.0.1", "::ffff:100.64.0.1",
      "64:ff9b::10.0.0.1", "2002:c0a8:0101::1", "::127.0.0.1",
      "pas-une-ip",
    ];
    for (const ip of refused) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of [PUBLIC, "8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8", "2002:0808:0808::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("noms du réseau local refusés à l'écriture", () => {
    for (const h of ["localhost", "ct.localhost", "nas.lan", "pve.local", "erp.internal", "box.home.arpa", "nas", "192.168.1.10", "[::1]", "[::ffff:127.0.0.1]"]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ["client.fr", "www.client-exemple.fr", PUBLIC]) expect(isPrivateHost(h), h).toBe(false);
  });

  it("résolution : refus si UNE adresse est privée ; IP littérale vérifiée sans DNS", async () => {
    const { lookup, calls } = fakeLookup({ "a.fr": [PUBLIC], "mixte.fr": [PUBLIC, "10.0.0.5"], "lan.attaquant.tld": ["192.168.1.1"], "v6.fr": ["::ffff:7f00:1"] });
    expect(await resolvePublic("a.fr", lookup)).toEqual(v4(PUBLIC));
    for (const h of ["mixte.fr", "lan.attaquant.tld", "v6.fr", "127.0.0.1", "[::1]", "nas.lan"]) await expect(resolvePublic(h, lookup), h).rejects.toThrow(/adresse privée/);
    expect(calls).toEqual(["a.fr", "mixte.fr", "lan.attaquant.tld", "v6.fr"]);
  });
});

describe("fetch protégé (une résolution par saut, connexion à l'adresse vérifiée)", () => {
  it("DNS rebinding : le nom n'est résolu qu'une fois, la connexion va à l'adresse vérifiée", async () => {
    // 1er appel : adresse publique ; 2e appel : la box. Il n'y a jamais de 2e appel.
    const { lookup, calls } = fakeLookup({ "rebind.fr": (n) => (n === 1 ? [PUBLIC] : ["192.168.1.1"]) });
    const net = fakeConnect(() => new Response("ok"));
    const r = await httpCheck("https://rebind.fr/", { fetch: guardedFetch({ lookup, connect: net.connect }) });
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(calls).toEqual(["rebind.fr"]);
    expect(net.calls).toEqual([{ url: "https://rebind.fr/", address: PUBLIC }]);
  });

  it("redirection vers 127.0.0.1, IPv4 mappée, CGNAT, nom résolu en 10.x : refusée, sans connexion", async () => {
    for (const target of ["http://127.0.0.1:3101/api/system", "http://[::ffff:127.0.0.1]:3100/", "http://[::ffff:7f00:1]/", "http://100.64.1.1/", "http://erp.piege.fr:3100/"]) {
      const { lookup } = fakeLookup({ "site.fr": [PUBLIC], "erp.piege.fr": ["10.0.0.20"] });
      const net = fakeConnect((url) => (url === "https://site.fr/" ? redirectTo(target) : new Response("secret")));
      const r = await httpCheck("https://site.fr/", { fetch: guardedFetch({ lookup, connect: net.connect }) });
      expect(r, target).toMatchObject({ ok: false, status: null, reason: "adresse privée refusée" });
      expect(net.calls.map((c) => c.url), target).toEqual(["https://site.fr/"]);
    }
  });

  it("chaque saut est résolu et vérifié ; 5 redirections au plus", async () => {
    const { lookup, calls } = fakeLookup({ "a.fr": [PUBLIC], "b.fr": ["198.51.100.7"] });
    const hops = fakeConnect((url) => (url === "https://a.fr/" ? redirectTo("https://b.fr/") : new Response("fin")));
    expect(await httpCheck("https://a.fr/", { fetch: guardedFetch({ lookup, connect: hops.connect }) })).toMatchObject({ ok: true });
    expect(calls).toEqual(["a.fr", "b.fr"]);
    expect(hops.calls.map((c) => c.address)).toEqual([PUBLIC, "198.51.100.7"]);

    const loop = fakeConnect((url) => redirectTo(`${url}x`));
    expect(await httpCheck("https://a.fr/", { fetch: guardedFetch({ lookup, connect: loop.connect }) })).toMatchObject({ ok: false, reason: "trop de redirections" });
    expect(loop.calls).toHaveLength(6);

    // Suivi automatique (RDAP) : mêmes contrôles et même plafond.
    const auto = fakeConnect((url) => (url.endsWith("/z") ? redirectTo("http://192.168.1.1/") : redirectTo(`${url}z`)));
    await expect(guardedFetch({ lookup, connect: auto.connect })("https://a.fr/")).rejects.toThrow(/adresse privée/);
    const autoLoop = fakeConnect((url) => redirectTo(`${url}y`));
    await expect(guardedFetch({ lookup, connect: autoLoop.connect })("https://a.fr/")).rejects.toThrow(/trop de redirections/);
    expect(autoLoop.calls).toHaveLength(6);
  });

  it("connexion réelle : adresse imposée sans résolution, en-tête Host d'origine ; adresse privée jamais contactée", async () => {
    let seen: IncomingHttpHeaders | null = null;
    let hits = 0;
    const server = createServer((req, res) => {
      hits++;
      seen = req.headers;
      res.writeHead(200, { "Content-Type": "text/plain" }).end("Bonjour");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      // Nom inexistant (.invalid) : s'il était résolu, la connexion échouerait.
      const res = await pinnedRequest(new URL(`http://site.invalid:${port}/accueil`), { headers: { "User-Agent": "test" } }, v4("127.0.0.1"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("Bonjour");
      expect(seen!.host).toBe(`site.invalid:${port}`);

      // Par défaut, httpCheck passe par la garde : 127.0.0.1 n'est jamais contacté.
      hits = 0;
      expect(await httpCheck(`http://127.0.0.1:${port}/`)).toMatchObject({ ok: false, reason: "adresse privée refusée" });
      const { lookup } = fakeLookup({ "lan.attaquant.tld": ["127.0.0.1"] });
      expect(await httpCheck(`http://lan.attaquant.tld:${port}/`, { fetch: guardedFetch({ lookup }) })).toMatchObject({ reason: "adresse privée refusée" });
      expect(hits).toBe(0);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("TLS : poignée de main sur l'adresse vérifiée avec le nom d'origine en SNI ; adresse privée refusée", async () => {
    const { lookup, calls } = fakeLookup({ "a.fr": (n) => (n === 1 ? [PUBLIC] : ["10.0.0.1"]), "box.piege.fr": ["192.168.1.254"] });
    const seen: Array<{ host?: string; servername?: string }> = [];
    const connect = ((opts: { host?: string; servername?: string }) => {
      seen.push({ host: opts.host, servername: opts.servername });
      throw new Error("arrêt du test");
    }) as unknown as Parameters<typeof makeTlsConnector>[1];
    const connector = makeTlsConnector(lookup, connect);
    await expect(connector("a.fr")).rejects.toThrow("arrêt du test");
    expect(seen).toEqual([{ host: PUBLIC, servername: "a.fr" }]);
    expect(calls).toEqual(["a.fr"]);
    const r = await tlsCheck("box.piege.fr", connector);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/adresse privée refusée/) });
    expect(seen).toHaveLength(1);
  });
});

describe("mesure de vitesse : lancement", () => {
  it("production sans utilisateur dédié, root sans utilisateur, lanceur absent : désactivée avec la raison", async () => {
    expect(await speedLauncher({ production: true, chromiumUser: null, chromiumPath: process.execPath })).toEqual({ ok: false, reason: expect.stringMatching(/HUB_CHROMIUM_USER/) });
    expect(await speedLauncher({ production: false, chromiumUser: null, isRoot: true, chromiumPath: process.execPath })).toEqual({ ok: false, reason: expect.stringMatching(/root/) });
    expect(await speedLauncher({ production: true, chromiumUser: "kouziahub-chromium", chromiumPath: path.join(tmpdir(), "absent-kz") })).toEqual({
      ok: false,
      reason: expect.stringMatching(/lanceur de Chromium/),
    });
    expect(await speedLauncher({ production: true, chromiumUser: "kouziahub-chromium", chromiumPath: process.execPath })).toEqual({ ok: true, executablePath: process.execPath, viaUser: "kouziahub-chromium" });
    expect(await speedStatus({ production: true, chromiumUser: null })).toEqual({ available: false, reason: expect.stringMatching(/HUB_CHROMIUM_USER/) });
  });

  it("bac à sable refusé par pipe et par port : indisponible, jamais de lancement sans bac à sable", async () => {
    const launches: Array<{ chromiumSandbox?: boolean; args?: string[] }> = [];
    const spawned: string[][] = [];
    const r = await measureSpeed("https://client.fr/", {
      chromiumPath: process.execPath,
      chromiumUser: "kouziahub-chromium",
      launch: async (o) => {
        launches.push({ chromiumSandbox: o.chromiumSandbox, args: o.args });
        throw new Error("No usable sandbox!");
      },
      spawnBrowser: (_exe, args) => {
        spawned.push(args);
        return spawn(process.execPath, ["-e", "process.stderr.write('No usable sandbox!\\n'); process.exit(1)"], { stdio: ["ignore", "ignore", "pipe"] });
      },
    });
    expect(r).toEqual({ available: false, reason: expect.stringMatching(/bac à sable.*pipe : No usable sandbox!.*port : lanceur arrêté/) });
    expect(launches).toEqual([{ chromiumSandbox: true, args: ["--no-first-run", "--disable-background-networking"] }]);
    expect(spawned).toEqual([portLaunchArgs([])]);
    for (const args of [...spawned, ...launches.map((l) => l.args ?? [])]) expect(args.some((a) => /no-sandbox|disable-setuid/.test(a))).toBe(false);
    expect(await speedStatus({ chromiumPath: process.execPath, chromiumUser: "kouziahub-chromium" })).toEqual({ available: false, reason: r.available ? null : r.reason });
  });

  it("lancement par port : adresse DevTools lue sur la sortie d'erreur du lanceur (faux lanceur node)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kz-lanceur-"));
    const script = path.join(dir, "faux-lanceur.cjs");
    await writeFile(
      script,
      "const args = process.argv.slice(2);\n" +
        "if (!args.includes('--remote-debugging-port=0')) process.exit(2);\n" +
        "process.stderr.write('\\nDevTools listening on ws://127.0.0.1:45678/devtools/browser/abc\\n');\n" +
        "setTimeout(() => {}, 60000);\n",
    );
    const viaNode = (_exe: string, args: string[]) => spawn(process.execPath, [script, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    const { wsUrl, child } = await startForCdp("/usr/local/lib/kouziahub/chromium-launch", viaNode, 10_000);
    expect(wsUrl).toBe("ws://127.0.0.1:45678/devtools/browser/abc");
    child.kill();

    const outside = path.join(dir, "faux-lanceur-dehors.cjs");
    await writeFile(outside, "process.stderr.write('DevTools listening on ws://0.0.0.0:45678/devtools/browser/abc\\n'); setTimeout(() => {}, 60000);\n");
    await expect(startForCdp("x", ((_e: string, a: string[]) => spawn(process.execPath, [outside, ...a], { stdio: ["ignore", "ignore", "pipe"] })) as SpawnBrowser, 10_000)).rejects.toThrow(/hors de 127\.0\.0\.1/);
  });

  it("Chromium sous un autre compte (doas) : kill en EPERM ne fait pas échouer la fermeture", async () => {
    // Comme Node : kill() vers un processus d'un autre compte émet « error » (EPERM) ; sans écouteur, c'est levé.
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      stderr: new PassThrough(),
      kills: 0,
      kill(this: EventEmitter & { kills: number }) {
        this.kills++;
        this.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
        return false;
      },
    });
    const started = await startChromium("/usr/local/lib/kouziahub/chromium-launch", {
      timeoutMs: 5_000,
      launch: async () => {
        throw new Error("pipe fermé par doas");
      },
      spawnBrowser: () => {
        setImmediate(() => child.stderr.write("DevTools listening on ws://127.0.0.1:45678/devtools/browser/abc\n"));
        return child as unknown as ChildProcess;
      },
      connect: async () => ({ newBrowserCDPSession: async () => null, close: async () => undefined }) as unknown as Browser,
    });
    expect(started.via).toBe("port");
    const close = started.close();
    child.emit("exit", null, null);
    Object.assign(child, { exitCode: 0 });
    await expect(close).resolves.toBeUndefined();
    // Processus déjà sorti : plus de kill du tout.
    expect(child.kills).toBe(0);

    // Toujours là après Browser.close : kill tenté une fois, EPERM avalé.
    const stuck = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kills: 0, kill: child.kill });
    expect(() => stopChild(stuck as unknown as ChildProcess)).not.toThrow();
    expect(stuck.kills).toBe(1);
  });

  it("requêtes de la page : schéma http(s), adresse résolue publique", async () => {
    const { lookup } = fakeLookup({ "cdn.fr": [PUBLIC], "lan.attaquant.tld": ["192.168.1.1"], "mixte.fr": [PUBLIC, "fd00::2"] });
    expect(await speedRequestAllowed("https://cdn.fr/a.css", lookup)).toBe(true);
    for (const u of ["https://lan.attaquant.tld/", "https://mixte.fr/", "http://192.168.1.1/", "http://[::ffff:c0a8:101]/", "http://100.64.0.1/", "ftp://cdn.fr/", "ws://cdn.fr/", "pas une url"]) {
      expect(await speedRequestAllowed(u, lookup), u).toBe(false);
    }
  });
});

const localChromium = await resolveChromium();
describe.skipIf(!localChromium)("mesure de vitesse avec le Chromium local", () => {
  it("pipe refusé (lanceur qui ferme les descripteurs) : mesure par port et connexion CDP ; adresse privée bloquée par l'interception", { timeout: 120_000 }, async () => {
    let lan = 0;
    const server = createServer((req, res) => {
      if (req.url === "/s.css") return res.writeHead(200, { "Content-Type": "text/css" }).end("h1{font-size:40px}");
      if (req.url === "/lan") {
        lan++;
        return res.writeHead(200).end("ok");
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end('<!doctype html><link rel="stylesheet" href="/s.css"><h1>Accueil</h1>');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const viaPort = {
      chromiumPath: localChromium,
      launch: async () => {
        throw new Error("pipe fermé par le lanceur");
      },
    };
    try {
      const r = await measureSpeed(`http://127.0.0.1:${port}/`, { ...viaPort, allowPrivate: true });
      expect(r).toMatchObject({ available: true, ok: true, error: null });
      if (!r.available) throw new Error("indisponible");
      expect(r.requests).toBeGreaterThanOrEqual(2);

      // Sans autorisation de test, l'interception bloque 127.0.0.1 : rien n'atteint le serveur.
      const blocked = await measureSpeed(`http://127.0.0.1:${port}/lan`, { ...viaPort, lookup: fakeLookup({}).lookup });
      expect(blocked).toMatchObject({ available: true, ok: false });
      expect(lan).toBe(0);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
