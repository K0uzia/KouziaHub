import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Site } from "@prisma/client";
import { refreshDirty } from "@/lib/files.js";
import { HttpError } from "@/lib/http.js";
import { PhpAgentOpError, PhpAgentUnavailableError, type PhpAgentClient, type PhpSiteSpec } from "@/lib/php-agent/client.js";
import type { PhpSiteSettings } from "@/contract.js";
// Règle de validation de l'agent, partagée telle quelle (une seule source de vérité).
import { checkSiteSpec, OpError, type SiteSpec } from "../../../../scripts/php-ct/agent/sites.mjs";
import { prisma } from "@/lib/prisma.js";
import { HTACCESS_PATH } from "@/lib/server-config.js";
import type { Services } from "@/lib/services.js";
import { CONFIG_FILES } from "@/lib/site-paths.js";
import { writeTarGz } from "@/lib/tar.js";

// Sites PHP côté hub (docs/cadrage.md, section 11.5) : réglages envoyés à l'agent, publication d'une version par
// archive puis bascule sur le CT, contrôle anti-fuite après chaque publication.

export const DEFAULT_PHP_VERSION = "8.3";

/** Agent du CT PHP, ou 503 explicite s'il n'est pas posé. */
export function agentOf(services: Services): PhpAgentClient {
  if (!services.phpAgent) throw new HttpError(503, "Serveur des sites PHP non relié (hubctl secrets php, README section 11.8).", "php_unavailable");
  return services.phpAgent;
}

export const persistentDirsOf = (site: Pick<Site, "phpPersistentDirs">) => (site.phpPersistentDirs ?? "").split("\n").map((d) => d.trim()).filter(Boolean);

export function specOf(site: Site, sitesDomain: string): PhpSiteSpec {
  return {
    slug: site.slug,
    hostname: `${site.slug}.${sitesDomain}`,
    php: site.phpVersion ?? DEFAULT_PHP_VERSION,
    publicDir: site.phpPublicDir ?? "",
    persistentDirs: persistentDirsOf(site),
    indexing: site.allowIndexing,
  };
}

/** Cible des CNAME des sites PHP : <identifiant du tunnel>.cfargotunnel.com, lu par l'agent. */
export async function phpDnsTarget(services: Services): Promise<string> {
  const id = await agentOf(services).tunnelId();
  if (!id) throw new HttpError(503, "Tunnel du CT PHP non réglé (kouziaphpctl tunnel) : pas de cible pour l'adresse du site.", "php_tunnel");
  return `${id}.cfargotunnel.com`;
}

/**
 * Publie une version d'un site PHP : réglages du site reposés, version envoyée si le CT ne l'a plus (sinon simple
 * bascule : retour arrière immédiat), puis contrôle anti-fuite ; une fuite coupe le site et fait échouer la publication.
 */
export async function deployPhpVersion(services: Services, siteId: string, versionId: string): Promise<void> {
  const agent = agentOf(services);
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
  const version = await prisma.version.findFirstOrThrow({ where: { id: versionId, siteId }, include: { files: true } });
  if (version.status === "PURGED") throw new HttpError(409, "Version purgée : ses fichiers ne sont plus gardés.");
  await agent.upsertSite(specOf(site, services.sitesDomain));
  await prisma.version.update({ where: { id: versionId }, data: { status: "UPLOADING", error: null } });

  try {
    await agent.publish(site.slug, version.number);
  } catch (err) {
    if (!(err instanceof PhpAgentOpError && err.status === 404)) throw err;
    // Version absente du CT (nouvelle, ou sortie des 5 gardées) : envoi de l'archive, puis bascule.
    const dir = path.join(services.dataDir, "tmp");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `php-${site.id}-${version.number}.tar.gz`);
    try {
      // _headers, _redirects (Cloudflare Pages) et .htaccess (Apache) n'ont pas de sens sous nginx : jamais envoyés.
      const entries = version.files
        .filter((f) => !CONFIG_FILES.has(f.path) && f.path !== HTACCESS_PATH)
        .map((f) => ({ path: f.path, size: f.size, read: () => services.blobs.read(f.sha256) }));
      const archive = await writeTarGz(entries, file);
      await agent.sendVersion(site.slug, version.number, { file, sha256: archive.sha256 });
    } finally {
      await rm(file, { force: true });
    }
    await agent.publish(site.slug, version.number);
  }

  const check = await agent.check(site.slug);
  if (!check.ok) {
    await agent.setEnabled(site.slug, false).catch(() => undefined);
    const leaks = check.results.filter((r) => r.status !== 403 && r.status !== 404).map((r) => `${r.path} (${r.status})`);
    throw new HttpError(500, `Fuite détectée après publication, site coupé : ${leaks.join(", ")} répond(ent) au lieu d'être refusé(s).`, "php_leak");
  }

  const now = new Date();
  await prisma.version.update({ where: { id: versionId }, data: { status: "PUBLISHED", publishedAt: now, error: null } });
  await prisma.site.update({ where: { id: siteId }, data: { currentVersionId: versionId, touchedAt: now } });
  await refreshDirty(siteId);
}

/**
 * Réglages d'un nouveau site PHP : versions de PHP lues sur le CT, puis validés par la règle de l'agent (même code
 * que sur le CT : scripts/php-ct/agent/sites.mjs). Défauts : PHP 8.3, dossier public « public ».
 */
export async function phpSettingsFor(services: Services, slug: string, input: Partial<PhpSiteSettings>): Promise<SiteSpec> {
  const agent = agentOf(services);
  let installed: string[];
  try {
    installed = (await agent.state()).php;
  } catch (err) {
    if (err instanceof PhpAgentUnavailableError) throw new HttpError(503, err.message, "php_unavailable");
    throw err;
  }
  try {
    return checkSiteSpec(
      {
        slug,
        hostname: `${slug}.${services.sitesDomain}`,
        php: input.version ?? DEFAULT_PHP_VERSION,
        publicDir: input.publicDir ?? "public",
        persistentDirs: input.persistentDirs ?? [],
      },
      { domain: services.sitesDomain, phpInstalled: () => installed },
    );
  } catch (err) {
    if (err instanceof OpError) throw new HttpError(400, err.message, "php_settings");
    throw err;
  }
}

