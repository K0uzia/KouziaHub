// Contrôles de la surveillance côté hub (cadrage 10.4). Chaque accès réseau est injectable :
// fetch (HTTP, RDAP), résolution des noms, connecteur TLS, résolveur DNS. Aucun réseau réel en test.
import { createHash } from "node:crypto";
import dns, { Resolver } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import tls, { type PeerCertificate } from "node:tls";

export const HTTP_TIMEOUT_MS = 10_000;
export const HTTP_MAX_REDIRECTS = 5;
export const HTTP_MAX_BYTES = 2 * 1024 * 1024;
export const USER_AGENT = "KouziaHub-Veille/1 (surveillance technique)";

const DAY_MS = 86_400_000;
export const daysUntil = (date: Date, now: number) => Math.floor((date.getTime() - now) / DAY_MS);

// --- Garde réseau : jamais de connexion vers le réseau local ou la machine (SSRF) ---

export type ResolvedAddress = { address: string; family: number };
/** Résolution d'un nom en adresses (toutes). Injectable : les tests n'interrogent aucun DNS. */
export type HostLookup = (hostname: string) => Promise<ResolvedAddress[]>;
export const systemLookup: HostLookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

export class PrivateAddressError extends Error {
  constructor(host: string) {
    super(`adresse privée refusée (${host.slice(0, 80)})`);
    this.name = "PrivateAddressError";
  }
}

/** Octets d'une IPv6 (16), null si l'écriture est invalide. Gère « :: » et la fin en IPv4 pointée. */
function ipv6Bytes(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  let tail: number[] | null = null;
  const lastColon = s.lastIndexOf(":");
  const v4 = s.slice(lastColon + 1);
  if (v4.includes(".")) {
    if (isIP(v4) !== 4) return null;
    tail = v4.split(".").map(Number);
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parts = (p: string) => (p === "" ? [] : p.split(":"));
  const head = parts(halves[0]!);
  const rest = halves.length === 2 ? parts(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 255);
  }
  if (tail) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** 0/8, 10/8, 127/8, CGNAT 100.64/10, lien local 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, multicast et réservé (224/3). */
function privateV4(b: number[]): boolean {
  const [a, c, d] = b as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && c >= 64 && c <= 127) ||
    (a === 169 && c === 254) ||
    (a === 172 && c >= 16 && c <= 31) ||
    (a === 192 && c === 0 && d === 0) ||
    (a === 192 && c === 168) ||
    (a === 198 && (c === 18 || c === 19)) ||
    a >= 224
  );
}

/**
 * Adresse IP à ne jamais joindre : plages privées et spéciales IPv4 (privateV4) ; en IPv6, non
 * spécifiée et boucle locale (::, ::1, et tout ::/96), IPv4 mappée (::ffff:a.b.c.d, vérifiée comme
 * IPv4), NAT64 (64:ff9b::/96) et 6to4 (2002::/16) vers une IPv4 privée, ULA fc00::/7, lien local
 * fe80::/10, site local fec0::/10, multicast ff00::/8. Ce qui n'est pas une IP est refusé.
 */
export function isPrivateAddress(ip: string): boolean {
  const host = ip.replace(/^\[|\]$/g, "");
  const kind = isIP(host);
  if (kind === 4) return privateV4(host.split(".").map(Number));
  if (kind !== 6) return true;
  const b = ipv6Bytes(host);
  if (!b) return true;
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return privateV4(b.slice(12));
  if (zero(0, 12)) return true;
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return privateV4(b.slice(12));
  if (b[0] === 0x20 && b[1] === 0x02) return privateV4(b.slice(2, 6));
  if ((b[0]! & 0xfe) === 0xfc) return true;
  if (b[0] === 0xfe && (b[1]! & 0x80) === 0x80) return true;
  return b[0] === 0xff;
}

/** Noms réservés au réseau local (sans résolution) : localhost, .local, .lan, .internal, .home.arpa, nom sans point. */
const LOCAL_NAME = /(^|\.)(localhost|local|lan|internal|home\.arpa)$/;

/** Nom ou IP du réseau local ou de la machine, d'après l'écriture seule (refus à l'ajout d'une cible). */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIP(host)) return isPrivateAddress(host);
  return !host.includes(".") || LOCAL_NAME.test(host);
}

/**
 * Résolution unique d'un nom, puis contrôle : refus si UNE des adresses est privée. L'adresse rendue
 * est celle à laquelle se connecter, sans seconde résolution (pas de DNS rebinding possible).
 */
export async function resolvePublic(hostname: string, lookup: HostLookup): Promise<ResolvedAddress> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const kind = isIP(host);
  if (kind) {
    if (isPrivateAddress(host)) throw new PrivateAddressError(host);
    return { address: host, family: kind };
  }
  if (isPrivateHost(host)) throw new PrivateAddressError(host);
  const all = await lookup(host);
  if (all.length === 0) throw new Error("nom introuvable");
  if (all.some((a) => isPrivateAddress(a.address))) throw new PrivateAddressError(host);
  return all[0]!;
}

/** Requête HTTP vers une adresse déjà vérifiée : le nom reste dans l'URL (Host, SNI, certificat). */
export type PinnedConnect = (url: URL, init: RequestInit, pinned: ResolvedAddress) => Promise<Response>;

/**
 * node:http(s) avec une résolution qui rend exactement l'adresse vérifiée (jamais le DNS) ; en-tête
 * Host et nom TLS (SNI, contrôle du certificat) restent ceux de l'URL. Aucune redirection suivie.
 */
export const pinnedRequest: PinnedConnect = (url, init, pinned) =>
  new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const lookup = ((_name: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) => {
      if (opts?.all) cb(null, [pinned]);
      else cb(null, pinned.address, pinned.family);
    }) as unknown as http.RequestOptions["lookup"];
    const options: https.RequestOptions = {
      protocol: url.protocol,
      hostname: host,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: init.method ?? "GET",
      headers,
      agent: false,
      lookup,
      signal: init.signal ?? undefined,
      ...(url.protocol === "https:" && !isIP(host) ? { servername: host } : {}),
    };
    const req = (url.protocol === "https:" ? https : http).request(options, (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status > 599) {
        res.destroy();
        reject(new Error(`statut ${status} inattendu`));
        return;
      }
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue;
        for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
      }
      const noBody = [204, 205, 304].includes(status) || options.method === "HEAD";
      if (noBody) res.resume();
      resolve(new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers: h }));
    });
    req.on("error", reject);
    if (typeof init.body === "string") req.write(init.body);
    req.end();
  });

/**
 * fetch protégé : chaque requête (et chaque saut de redirection, suivi à la main, 5 au plus) résout
 * le nom une fois, refuse une adresse privée, puis se connecte à l'adresse vérifiée.
 */
export function guardedFetch(options: { lookup?: HostLookup; connect?: PinnedConnect } = {}): typeof fetch {
  const lookup = options.lookup ?? systemLookup;
  const connect = options.connect ?? pinnedRequest;
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    let url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    for (let hop = 0; ; hop++) {
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new TypeError("adresse refusée");
      const res = await connect(url, init, await resolvePublic(url.hostname, lookup));
      const location = res.headers.get("location");
      if (init.redirect === "manual" || res.status < 300 || res.status >= 400 || res.status === 304 || !location) return res;
      await res.body?.cancel().catch(() => undefined);
      if (hop >= HTTP_MAX_REDIRECTS) throw new TypeError("trop de redirections");
      url = new URL(location, url);
    }
  }) as typeof fetch;
}

// --- HTTP ---

export type HttpCheckResult = {
  ok: boolean;
  status: number | null;
  ms: number | null;
  reason: string | null;
  finalUrl: string;
  /** HTML lu (2 Mio au plus), seulement si demandé. */
  body: string | null;
};

/** Corps lu en flux, coupé au plafond (jamais plus de maxBytes en mémoire). */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - size;
    chunks.push(value.length > room ? value.subarray(0, room) : value);
    size += Math.min(value.length, room);
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * GET avec redirections suivies à la main (5 au plus), délai global de 10 s, corps plafonné à 2 Mio.
 * Réussite : statut final 2xx ou 3xx, et mot-clé présent s'il est demandé. Par défaut, chaque saut
 * passe par guardedFetch (adresse résolue et vérifiée avant la connexion).
 */
export async function httpCheck(
  url: string,
  options: { fetch?: typeof fetch; keyword?: string | null; wantBody?: boolean; timeoutMs?: number; now?: () => number } = {},
): Promise<HttpCheckResult> {
  const fetchImpl = options.fetch ?? guardedFetch();
  const now = options.now ?? Date.now;
  const signal = AbortSignal.timeout(options.timeoutMs ?? HTTP_TIMEOUT_MS);
  const started = now();
  let current = url;
  try {
    for (let hop = 0; ; hop++) {
      const res = await fetchImpl(current, { method: "GET", redirect: "manual", signal, headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" } });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => undefined);
        if (hop >= HTTP_MAX_REDIRECTS) return { ok: false, status: res.status, ms: now() - started, reason: "trop de redirections", finalUrl: current, body: null };
        const next = new URL(location, current);
        if (next.protocol !== "https:" && next.protocol !== "http:") {
          return { ok: false, status: res.status, ms: now() - started, reason: "redirection invalide", finalUrl: current, body: null };
        }
        current = next.toString();
        continue;
      }
      const ms = now() - started;
      const needBody = Boolean(options.keyword) || options.wantBody;
      const body = needBody ? await readCapped(res, HTTP_MAX_BYTES) : (await res.body?.cancel().catch(() => undefined), null);
      if (res.status >= 400) return { ok: false, status: res.status, ms, reason: `statut ${res.status}`, finalUrl: current, body };
      if (options.keyword && !(body ?? "").includes(options.keyword)) {
        return { ok: false, status: res.status, ms, reason: "mot-clé absent", finalUrl: current, body };
      }
      return { ok: true, status: res.status, ms, reason: null, finalUrl: current, body };
    }
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (err instanceof PrivateAddressError) return { ok: false, status: null, ms: null, reason: "adresse privée refusée", finalUrl: current, body: null };
    const reason = name === "TimeoutError" || name === "AbortError" ? "délai dépassé" : "connexion impossible";
    return { ok: false, status: null, ms: null, reason, finalUrl: current, body: null };
  }
}

// --- Certificat ---

export type PeerInfo = { cert: Pick<PeerCertificate, "valid_to" | "issuer" | "subject" | "subjectaltname">; authorized: boolean; authorizationError: string | null };
export type TlsConnector = (hostname: string) => Promise<PeerInfo>;

type TlsConnect = (options: tls.ConnectionOptions, secureListener: () => void) => tls.TLSSocket;

/**
 * Poignée de main sur l'adresse résolue une fois et vérifiée (resolvePublic), avec le nom d'origine
 * en SNI : même garde que pour HTTP.
 */
export const makeTlsConnector =
  (lookup: HostLookup = systemLookup, connect: TlsConnect = tls.connect): TlsConnector =>
  async (hostname) => {
    const pinned = await resolvePublic(hostname, lookup);
    return tlsHandshake(connect, pinned.address, isIP(hostname) ? undefined : hostname);
  };

const tlsHandshake = (connect: TlsConnect, address: string, servername: string | undefined): Promise<PeerInfo> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: address, port: 443, servername, rejectUnauthorized: false, timeout: HTTP_TIMEOUT_MS }, () => {
      const cert = socket.getPeerCertificate();
      resolve({
        cert,
        authorized: socket.authorized,
        authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
      });
      socket.end();
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("délai dépassé"));
    });
    socket.once("error", (err) => reject(err));
  });

export const nodeTlsConnector: TlsConnector = makeTlsConnector();

export type TlsCheckResult = { ok: boolean; validTo: string | null; daysLeft: number | null; issuer: string | null; error: string | null };

/** Poignée de main TLS : échéance, émetteur, nom couvert, chaîne reconnue. */
export async function tlsCheck(hostname: string, connector: TlsConnector = nodeTlsConnector, now = Date.now()): Promise<TlsCheckResult> {
  let peer: PeerInfo;
  try {
    peer = await connector(hostname);
  } catch (err) {
    return { ok: false, validTo: null, daysLeft: null, issuer: null, error: `connexion TLS impossible${err instanceof Error && err.message ? ` (${err.message.slice(0, 80)})` : ""}` };
  }
  const validTo = peer.cert.valid_to ? new Date(peer.cert.valid_to) : null;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || null;
  const issuer = first(peer.cert.issuer?.O) ?? first(peer.cert.issuer?.CN);
  const days = validTo && !Number.isNaN(validTo.getTime()) ? daysUntil(validTo, now) : null;
  let error: string | null = null;
  if (!validTo || days === null) error = "certificat illisible";
  else if (validTo.getTime() <= now) error = "certificat expiré";
  else if (tls.checkServerIdentity(hostname, peer.cert as PeerCertificate)) error = "nom non couvert par le certificat";
  else if (!peer.authorized) error = `certificat non reconnu (${peer.authorizationError ?? "chaîne invalide"})`;
  return { ok: error === null, validTo: validTo && days !== null ? validTo.toISOString() : null, daysLeft: days, issuer, error };
}

// --- Échéance du domaine (RDAP) ---

/** Domaine enregistrable approché : deux derniers libellés (les suffixes à deux niveaux, ex. co.uk, sont à traiter plus tard). */
export const registrableDomain = (hostname: string) => hostname.toLowerCase().split(".").slice(-2).join(".");

export type RdapResult = { expiresAt: string | null; registrar: string | null };

const IANA_BOOTSTRAP = "https://data.iana.org/rdap/dns.json";

/** Client RDAP public : serveur trouvé par l'amorce IANA (gardée 24 h en mémoire). */
export class RdapClient {
  private bootstrap: { at: number; services: Array<[string[], string[]]> } | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.fetchImpl = options.fetch ?? guardedFetch();
    this.now = options.now ?? Date.now;
  }

  private async services(): Promise<Array<[string[], string[]]>> {
    if (this.bootstrap && this.now() - this.bootstrap.at < DAY_MS) return this.bootstrap.services;
    const res = await this.fetchImpl(IANA_BOOTSTRAP, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("amorce RDAP indisponible");
    const json = (await res.json()) as { services?: Array<[string[], string[]]> };
    this.bootstrap = { at: this.now(), services: json.services ?? [] };
    return this.bootstrap.services;
  }

  async lookup(hostname: string): Promise<RdapResult> {
    const domain = registrableDomain(hostname);
    const tld = domain.split(".").pop()!;
    const service = (await this.services()).find(([tlds]) => tlds.map((t) => t.toLowerCase()).includes(tld));
    const base = service?.[1].find((u) => u.startsWith("https://")) ?? service?.[1][0];
    if (!base) return { expiresAt: null, registrar: null };
    const res = await this.fetchImpl(`${base.replace(/\/?$/, "/")}domain/${encodeURIComponent(domain)}`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { Accept: "application/rdap+json, application/json" },
    });
    if (!res.ok) return { expiresAt: null, registrar: null };
    const json = (await res.json()) as {
      events?: Array<{ eventAction?: string; eventDate?: string }>;
      entities?: Array<{ roles?: string[]; vcardArray?: [string, Array<[string, unknown, string, unknown]>] }>;
    };
    const expiration = json.events?.find((e) => e.eventAction === "expiration")?.eventDate;
    const date = expiration ? new Date(expiration) : null;
    const registrarEntity = json.entities?.find((e) => e.roles?.includes("registrar"));
    const fn = registrarEntity?.vcardArray?.[1]?.find((f) => f[0] === "fn")?.[3];
    return {
      expiresAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
      registrar: typeof fn === "string" ? fn.slice(0, 120) : null,
    };
  }
}

// --- DNS ---

export type DnsResolver = {
  resolve4(h: string): Promise<string[]>;
  resolve6(h: string): Promise<string[]>;
  resolveCname(h: string): Promise<string[]>;
  resolveNs(h: string): Promise<string[]>;
  resolveMx(h: string): Promise<Array<{ priority: number; exchange: string }>>;
};

export type DnsSnapshot = { A: string[]; AAAA: string[]; CNAME: string[]; NS: string[]; MX: string[] };
export const DNS_TYPES = ["A", "AAAA", "CNAME", "NS", "MX"] as const;

export function defaultResolver(): DnsResolver {
  const r = new Resolver({ timeout: 5000, tries: 2 });
  return r;
}

const noData = (err: unknown) => ["ENODATA", "ENOTFOUND", "ENOTIMP", "NXDOMAIN"].includes((err as { code?: string }).code ?? "");
async function records<T>(p: Promise<T[]>): Promise<T[]> {
  try {
    return await p;
  } catch (err) {
    if (noData(err)) return [];
    throw err;
  }
}

/** A, AAAA, CNAME de l'adresse ; NS et MX du domaine enregistrable. Valeurs triées, en minuscules. */
export async function dnsSnapshot(hostname: string, resolver: DnsResolver): Promise<DnsSnapshot> {
  const domain = registrableDomain(hostname);
  const [a, aaaa, cname, ns, mx] = await Promise.all([
    records(resolver.resolve4(hostname)),
    records(resolver.resolve6(hostname)),
    records(resolver.resolveCname(hostname)),
    records(resolver.resolveNs(domain)),
    records(resolver.resolveMx(domain)),
  ]);
  const norm = (list: string[]) => [...new Set(list.map((v) => v.toLowerCase().replace(/\.$/, "")))].sort();
  return { A: norm(a), AAAA: norm(aaaa), CNAME: norm(cname), NS: norm(ns), MX: norm(mx.map((m) => `${m.priority} ${m.exchange}`)) };
}

/** Types d'enregistrement qui diffèrent de la référence. */
export function dnsDrift(reference: DnsSnapshot, current: DnsSnapshot): string[] {
  return DNS_TYPES.filter((t) => JSON.stringify(reference[t] ?? []) !== JSON.stringify(current[t] ?? []));
}

// --- Contenu de l'accueil ---

/**
 * HTML normalisé : sans commentaires, scripts, nonces, jetons, champs cachés, dates ni horodatages,
 * blancs réduits. Deux chargements d'une page inchangée donnent la même empreinte.
 */
export function normalizeHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "<script></script>")
    .replace(/\s(?:nonce|integrity)="[^"]*"/gi, "")
    .replace(/<meta[^>]+name="(?:csrf[^"]*|_token)"[^>]*>/gi, "")
    .replace(/<input[^>]+type="hidden"[^>]*>/gi, "")
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, "<date>")
    .replace(/\b\d{10,13}\b/g, "<horodatage>")
    .replace(/([?&](?:v|ver|t|ts|cb|_)=)[^"'&\s>]+/gi, "$1<v>")
    .replace(/\s+/g, " ")
    .trim();
}

export const contentHash = (html: string) => createHash("sha256").update(normalizeHtml(html)).digest("hex");
