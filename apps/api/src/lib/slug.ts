import type { SlugCheck } from "@/contract.js";
import type { CloudflareGateway } from "@/lib/cloudflare/types.js";
import { prisma } from "@/lib/prisma.js";

export const SLUG_MAX = 40;

/** Sous-domaines jamais attribués à un site (services, usages techniques, marque). */
export const RESERVED_SLUGS = new Set([
  "www", "erp", "api", "hub", "mail", "admin", "app", "dev", "staging", "test", "ftp", "smtp", "imap", "pop", "pop3",
  "webmail", "autodiscover", "autoconfig", "cdn", "static", "assets", "status", "docs", "help", "support", "portal",
  "login", "auth", "sso", "vpn", "ns", "ns1", "ns2", "ns3", "mx", "git", "crm", "kouzia", "email", "smtp1", "mta",
  "dns", "proxy", "intranet", "dashboard", "panel", "cpanel", "root", "localhost", "demo", "preview",
  "secure", "account", "accounts", "billing", "pay", "payment", "files", "upload", "uploads", "backup", "db", "sql",
  "mysql", "metrics", "monitor", "grafana", "id", "oauth", "cloud", "server",
]);

export const PAGES_PROJECT_PREFIX = "kz-";
export const projectNameFor = (slug: string) => `${PAGES_PROJECT_PREFIX}${slug}`;

/** Erreur de format affichable, null si le format est bon. */
export function slugFormatError(slug: string): string | null {
  if (slug.length === 0) return "Sous-domaine vide.";
  if (slug.length > SLUG_MAX) return `${SLUG_MAX} caractères au plus.`;
  if (!/^[a-z0-9-]+$/.test(slug)) return "Lettres minuscules sans accent, chiffres et tirets seulement.";
  if (slug.startsWith("-") || slug.endsWith("-")) return "Pas de tiret au début ni à la fin.";
  if (slug.includes("--")) return "Pas de double tiret.";
  if (RESERVED_SLUGS.has(slug)) return "Nom réservé.";
  return null;
}

/** Proposition depuis un nom : minuscules, sans accent, mots reliés par un tiret, 40 caractères au plus. */
export function suggestSlug(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[œ]/g, "oe")
    .replace(/[æ]/g, "ae")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return base;
}

/**
 * Contrôle complet : format, noms réservés, déjà pris dans le hub, puis chez Cloudflare (enregistrement
 * DNS déjà présent dans la zone, projet kz-<slug> existant hors hub).
 */
export async function checkSlug(slug: string, cloudflare: CloudflareGateway, sitesDomain: string): Promise<SlugCheck> {
  const formatError = slugFormatError(slug);
  if (formatError) return { slug, ok: false, reason: formatError };
  const taken = await prisma.site.findFirst({ where: { OR: [{ slug }, { pagesProject: projectNameFor(slug) }] }, select: { id: true } });
  if (taken) return { slug, ok: false, reason: "Sous-domaine déjà utilisé par un site du hub." };
  try {
    const record = await cloudflare.findDnsRecord(`${slug}.${sitesDomain}`);
    if (record) return { slug, ok: false, reason: `Un enregistrement DNS ${record.type} existe déjà pour ${slug}.${sitesDomain}.` };
    const project = await cloudflare.getProject(projectNameFor(slug));
    if (project) return { slug, ok: false, reason: `Un projet Cloudflare ${projectNameFor(slug)} existe déjà hors du hub.` };
  } catch (err) {
    return { slug, ok: false, reason: `Vérification chez Cloudflare impossible : ${err instanceof Error ? err.message : "erreur inconnue"}` };
  }
  return { slug, ok: true, reason: null };
}
