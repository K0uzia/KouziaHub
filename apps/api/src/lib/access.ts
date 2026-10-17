import { createPublicKey, verify, type KeyObject, type webcrypto } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AccessConfig } from "@/lib/env.js";

// Vérification du jeton Cloudflare Access (en-tête Cf-Access-Jwt-Assertion), comme le recommande
// Cloudflare : signature RS256 avec les clés publiques de https://<équipe>/cdn-cgi/access/certs,
// puis iss, aud, exp et nbf. Une requête qui contournerait Access (tunnel mal réglé, accès direct
// au port) reçoit la même 404 qu'une route inconnue.

/** Décalage d'horloge toléré entre le CT et Cloudflare. */
const CLOCK_SKEW_S = 60;
/** Clés gardées une heure ; une clé inconnue relance la lecture au plus une fois par minute. */
const KEYS_TTL_MS = 3_600_000;
const KEYS_RETRY_MS = 60_000;

export type FetchJson = (url: string) => Promise<unknown>;

const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`certs Access : HTTP ${res.status}`);
  return res.json();
};

type Jwk = { kty?: string; kid?: string; [key: string]: unknown };

export class AccessVerifier {
  private keys = new Map<string, KeyObject>();
  private loadedAt = 0;
  private lastAttempt = 0;

  constructor(
    private readonly config: AccessConfig,
    private readonly fetchJson: FetchJson = defaultFetchJson,
    private readonly now: () => number = Date.now,
  ) {}

  get issuer(): string {
    return `https://${this.config.teamDomain}`;
  }

  private async loadKeys(force: boolean): Promise<void> {
    const t = this.now();
    if (!force && this.keys.size > 0 && t - this.loadedAt < KEYS_TTL_MS) return;
    if (this.keys.size > 0 && t - this.lastAttempt < KEYS_RETRY_MS) return;
    this.lastAttempt = t;
    const body = (await this.fetchJson(`${this.issuer}/cdn-cgi/access/certs`)) as { keys?: Jwk[] };
    const next = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid || jwk.kty !== "RSA") continue;
      next.set(jwk.kid, createPublicKey({ key: jwk as webcrypto.JsonWebKey, format: "jwk" }));
    }
    if (next.size === 0) throw new Error("certs Access : aucune clé RSA");
    this.keys = next;
    this.loadedAt = t;
  }

  /** Vrai si le jeton est signé par Access, destiné à cette application et en cours de validité. */
  async verify(token: string | undefined): Promise<boolean> {
    if (!token) return false;
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: string; kid?: string };
    let payload: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string };
    try {
      header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
      payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    } catch {
      return false;
    }
    if (header.alg !== "RS256" || !header.kid) return false;

    try {
      await this.loadKeys(false);
      if (!this.keys.has(header.kid)) await this.loadKeys(true);
    } catch {
      // Clés illisibles (réseau) : refus, jamais d'ouverture par défaut.
      if (!this.keys.has(header.kid)) return false;
    }
    const key = this.keys.get(header.kid);
    if (!key) return false;
    const signed = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"));
    if (!signed) return false;

    const nowS = Math.floor(this.now() / 1000);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(this.config.audience)) return false;
    if (payload.iss !== this.issuer) return false;
    if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_S < nowS) return false;
    if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_S > nowS) return false;
    if (this.config.email && payload.email?.toLowerCase() !== this.config.email) return false;
    return true;
  }
}

/** Seule route ouverte sans jeton : contrôle de santé (hubctl, OpenRC), qui ne renvoie que { ok }. */
const OPEN_ROUTES = new Set(["/api/health"]);

export function registerAccessGuard(app: FastifyInstance, verifier: AccessVerifier | null): void {
  if (!verifier) return;
  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?")[0] ?? "";
    if (OPEN_ROUTES.has(pathname)) return;
    const header = request.headers["cf-access-jwt-assertion"];
    const token = Array.isArray(header) ? header[0] : header;
    if (await verifier.verify(token)) return;
    return reply.code(404).send({ error: "Not found" });
  });
}
