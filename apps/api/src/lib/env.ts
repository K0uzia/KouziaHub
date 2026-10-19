import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BlockList } from "node:net";
import { parseTrustedProxies } from "@/lib/client-ip.js";

/** Valeur d'exemple (« change-me… », quelle que soit la casse) : jamais un vrai secret. */
export const isExampleSecret = (v: string) => /^change-me/i.test(v.trim());

export const isProduction = () => process.env.NODE_ENV === "production";

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Variable d'environnement requise : ${name}`);
  }
  if (isExampleSecret(v) && isProduction()) {
    throw new Error(`Secret trop faible en production : ${name}`);
  }
  return v;
}

/** Clé d'exemple des tests : interdite en production. */
const EXAMPLE_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

export function assertSecurityEnv(): void {
  requireEnv("SESSION_SECRET");
  requireEnv("ENCRYPTION_KEY");
  const key = process.env.ENCRYPTION_KEY!;
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("ENCRYPTION_KEY doit faire 64 caractères hexadécimaux (openssl rand -hex 32)");
  }
  if (isProduction() && key.toLowerCase() === EXAMPLE_ENCRYPTION_KEY) {
    throw new Error("ENCRYPTION_KEY d'exemple interdite en production (openssl rand -hex 32)");
  }
}

function addOrigin(set: Set<string>, raw: string | undefined): void {
  for (const part of (raw ?? "").split(/[,\s]+/)) {
    const value = part.trim();
    if (!value) continue;
    let u: URL;
    try {
      u = new URL(value);
    } catch {
      throw new Error(`Origine invalide : « ${value} »`);
    }
    set.add(u.origin);
    // localhost et 127.0.0.1 sont équivalents en dev.
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      const alias = new URL(u.href);
      alias.hostname = u.hostname === "localhost" ? "127.0.0.1" : "localhost";
      set.add(alias.origin);
    }
  }
}

/** Origines autorisées pour les mutations : interface de dev et hub.kouzia.com. */
export function getAllowedOrigins(): string[] {
  const set = new Set<string>();
  addOrigin(set, process.env.WEB_ORIGIN ?? (isProduction() ? undefined : "http://localhost:5174"));
  addOrigin(set, process.env.HUB_PUBLIC_ORIGIN);
  if (!isProduction()) addOrigin(set, process.env.DEV_LAN_ORIGIN);
  return Array.from(set);
}

export function getApiPort(): number {
  return Number(process.env.API_PORT?.trim() || 3101);
}

/** Cookie Secure : COOKIE_SECURE explicite, sinon actif en production. */
export function getCookieSecure(): boolean {
  const v = process.env.COOKIE_SECURE?.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return isProduction();
}

/** Proxies de confiance (cloudflared sur le CT) : voir parseTrustedProxies. */
export function getTrustedProxies(): BlockList | null {
  return parseTrustedProxies(process.env.TRUST_PROXY, isProduction());
}

export type AccessConfig = {
  /** ex. « kouzia.cloudflareaccess.com » */
  teamDomain: string;
  audience: string;
  /** Adresse attendue dans le jeton (facultatif : la règle Access la filtre déjà). */
  email: string | null;
};

/**
 * Vérification du jeton Cloudflare Access, facultative (décision du 19/10/2026 : le hub est protégé comme
 * l'ERP, par son login avec mot de passe et code à 6 chiffres). Null : Access non renseigné ou coupé en dev.
 */
export function accessConfig(): AccessConfig | null {
  const disabled = ["true", "1"].includes(process.env.CF_ACCESS_DISABLED?.trim().toLowerCase() ?? "");
  if (disabled && !isProduction()) return null;
  const team = process.env.CF_ACCESS_TEAM_DOMAIN?.trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const audience = process.env.CF_ACCESS_AUD?.trim();
  if (!team || !audience) return null;
  return {
    teamDomain: team.toLowerCase(),
    audience,
    email: process.env.CF_ACCESS_EMAIL?.trim().toLowerCase() || null,
  };
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Données du hub (fichiers des sites, vignettes) : HUB_DATA_DIR, sinon data/ à la racine du dépôt. */
export function getDataDir(): string {
  return path.resolve(process.env.HUB_DATA_DIR?.trim() || path.join(repoRoot, "data"));
}

/** Zone des sous-domaines (kouzia.com). */
export function getSitesDomain(): string {
  return (process.env.HUB_SITES_DOMAIN?.trim() || "kouzia.com").toLowerCase();
}
