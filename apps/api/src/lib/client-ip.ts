import { BlockList, isIP } from "node:net";
import type { FastifyInstance } from "fastify";

/**
 * Proxies de confiance (TRUST_PROXY) :
 * - "true" : loopback seulement (cloudflared sur la même machine que l'API, CT Alpine) ;
 * - "false" : aucun (HTTP LAN pur) ;
 * - liste d'IP ou de CIDR séparés par des virgules (Docker : sous-réseau du conteneur cloudflared),
 *   le mot-clé "loopback" y est accepté.
 * Défaut : loopback en production, aucun sinon.
 */
export function parseTrustedProxies(raw: string | undefined, production: boolean): BlockList | null {
  const v = raw?.trim().toLowerCase();
  if (v === "false" || v === "0") return null;
  const entries = !v ? (production ? ["loopback"] : []) : v === "true" || v === "1" ? ["loopback"] : v.split(/[,\s]+/);
  if (entries.length === 0) return null;

  const list = new BlockList();
  for (const entry of entries.filter(Boolean)) {
    if (entry === "loopback") {
      list.addSubnet("127.0.0.0", 8, "ipv4");
      list.addAddress("::1", "ipv6");
      continue;
    }
    const [addr, bits] = entry.split("/");
    const family = isIP(addr ?? "");
    if (!addr || family === 0) throw new Error(`TRUST_PROXY : entrée invalide « ${entry} »`);
    const type = family === 4 ? "ipv4" : "ipv6";
    if (bits === undefined) list.addAddress(addr, type);
    else list.addSubnet(addr, Number(bits), type);
  }
  return list;
}

/** "::ffff:127.0.0.1" (IPv4 vue en IPv6) devient "127.0.0.1". */
function normalize(addr: string): string {
  return addr.startsWith("::ffff:") && isIP(addr.slice(7)) === 4 ? addr.slice(7) : addr;
}

export function isTrustedProxy(list: BlockList | null, addr: string | undefined): boolean {
  if (!list || !addr) return false;
  const a = normalize(addr);
  const family = isIP(a);
  if (family === 0) return false;
  return list.check(a, family === 4 ? "ipv4" : "ipv6");
}

/** Fonction trustProxy de Fastify : ne fait confiance qu'au saut immédiat s'il est un proxy listé. */
export function trustProxyFn(list: BlockList | null): ((addr: string, hop: number) => boolean) | false {
  if (!list) return false;
  return (addr, hop) => hop === 0 && isTrustedProxy(list, addr);
}

/**
 * Requête venue d'un proxy de confiance avec CF-Connecting-IP (posé par l'edge Cloudflare, que le
 * client ne peut pas imposer) : X-Forwarded-For est remplacé par cette seule IP, avant tout calcul
 * de request.ip (limites de débit, preuve de signature). Un X-Forwarded-For fourni par le client
 * n'est jamais lu.
 */
export function registerClientIpHook(app: FastifyInstance, list: BlockList | null): void {
  app.decorateRequest("viaTunnel", false);
  app.addHook("onRequest", async (request) => {
    const headers = request.raw.headers;
    if (!isTrustedProxy(list, request.raw.socket.remoteAddress)) {
      delete headers["x-forwarded-for"];
      return;
    }
    const cf = headers["cf-connecting-ip"];
    const value = (Array.isArray(cf) ? cf[0] : cf)?.trim();
    if (value && isIP(value)) {
      headers["x-forwarded-for"] = value;
      // Le Host d'origine arrive tel quel par cloudflared ; un X-Forwarded-Host viendrait du client.
      delete headers["x-forwarded-host"];
      request.viaTunnel = true;
    } else {
      // Proxy de confiance sans CF-Connecting-IP : un X-Forwarded-For présent viendrait du client.
      delete headers["x-forwarded-for"];
    }
  });
}

declare module "fastify" {
  interface FastifyRequest {
    /** Requête venue d'Internet par le tunnel Cloudflare (et non du LAN ou de Tailscale). */
    viaTunnel: boolean;
  }
}
