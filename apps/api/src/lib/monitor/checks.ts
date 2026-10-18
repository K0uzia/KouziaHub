// Contrôles de la surveillance côté hub (cadrage 10.4). Chaque accès réseau est injectable :
// fetch (HTTP, RDAP), connecteur TLS, résolveur DNS. Aucun réseau réel en test.
import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import tls, { type PeerCertificate } from "node:tls";

export const HTTP_TIMEOUT_MS = 10_000;
export const HTTP_MAX_REDIRECTS = 5;
export const HTTP_MAX_BYTES = 2 * 1024 * 1024;
export const USER_AGENT = "KouziaHub-Veille/1 (surveillance technique)";

const DAY_MS = 86_400_000;
export const daysUntil = (date: Date, now: number) => Math.floor((date.getTime() - now) / DAY_MS);

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
 * Réussite : statut final 2xx ou 3xx, et mot-clé présent s'il est demandé.
 */
export async function httpCheck(
  url: string,
  options: { fetch?: typeof fetch; keyword?: string | null; wantBody?: boolean; timeoutMs?: number; now?: () => number } = {},
): Promise<HttpCheckResult> {
  const fetchImpl = options.fetch ?? fetch;
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
    const reason = name === "TimeoutError" || name === "AbortError" ? "délai dépassé" : "connexion impossible";
    return { ok: false, status: null, ms: null, reason, finalUrl: current, body: null };
  }
}

// --- Certificat ---

export type PeerInfo = { cert: Pick<PeerCertificate, "valid_to" | "issuer" | "subject" | "subjectaltname">; authorized: boolean; authorizationError: string | null };
export type TlsConnector = (hostname: string) => Promise<PeerInfo>;

export const nodeTlsConnector: TlsConnector = (hostname) =>
  new Promise((resolve, reject) => {
    const socket = tls.connect({ host: hostname, port: 443, servername: hostname, rejectUnauthorized: false, timeout: HTTP_TIMEOUT_MS }, () => {
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
    this.fetchImpl = options.fetch ?? fetch;
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
