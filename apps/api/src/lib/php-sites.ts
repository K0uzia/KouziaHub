import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Site } from "@prisma/client";
import { refreshDirty } from "@/lib/files.js";
import { decrypt } from "@/lib/crypto.js";
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

/** Variables saisies d'un site PHP (JSON chiffré), {} si aucune. */
export function envOf(site: Pick<Site, "phpEnv">): Record<string, string> {
  if (!site.phpEnv) return {};
  const parsed = JSON.parse(decrypt(site.phpEnv)) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
}

export const linesOf =(text: string | null) => (text ?? "").split("\n").map((d) => d.trim()).filter(Boolean);
export const persistentDirsOf = (site: Pick<Site, "phpPersistentDirs">) => linesOf(site.phpPersistentDirs);

export function specOf(site: Site, sitesDomain: string): PhpSiteSpec {
  return {
    slug: site.slug,
    hostname: `${site.slug}.${sitesDomain}`,
    php: site.phpVersion ?? DEFAULT_PHP_VERSION,
    publicDir: site.phpPublicDir ?? "",
    persistentDirs: persistentDirsOf(site),
    publicPersistentDirs: linesOf(site.phpPublicPersistentDirs),
    memoryLimitMb: site.phpMemoryLimitMb,
    uploadMaxMb: site.phpUploadMaxMb,
    maxExecutionSec: site.phpMaxExecutionSec,
    cron: site.phpCronScript && site.phpCronEvery ? { script: site.phpCronScript, every: site.phpCronEvery } : null,
    indexing: site.allowIndexing,
    imapOpen: site.phpImapOpen,
    httpsOpen: site.phpHttpsOpen,
  };
}

/** Cible des CNAME des sites PHP : <identifiant du tunnel>.cfargotunnel.com, lu par l'agent. */
export async function phpDnsTarget(services: Services): Promise<string> {
  const id = await agentOf(services).tunnelId();
  if (!id) throw new HttpError(503, "Tunnel du CT PHP non réglé (kouziaphpctl tunnel) : pas de cible pour l'adresse du site.", "php_tunnel");
  return `${id}.cfargotunnel.com`;
}

/**
 * Contrôle anti-fuite (nginx local, sous le nom du site). Une fuite coupe le site et fait échouer la publication. Avant la
 * bascule : la version n'est pas publiée. Après : previous (version servie avant) est remise, puis le site coupé. Le
 * message dit lequel des deux contrôles a refusé et ce qui est servi ensuite.
 */
async function leakGate(agent: ReturnType<typeof agentOf>, slug: string, after: { previous: number | null } | null = null): Promise<void> {
  const check = await agent.check(slug);
  if (check.ok) return;
  let state = "version non publiée (la version servie ne change pas)";
  if (after) {
    if (after.previous === null) state = "aucune version précédente à remettre";
    else {
      const previous = after.previous;
      state = await agent.publish(slug, previous).then(
        () => `version précédente (${previous}) remise`,
        () => `retour à la version ${previous} impossible`,
      );
    }
  }
  await agent.setEnabled(slug, false).catch(() => undefined);
  const when = after ? "après la bascule" : "avant la bascule";
  // Statut 0 : nginx n'a pas répondu (délai de 2 s ou refus) ; le site est coupé quand même, par prudence.
  const silent = check.results.filter((r) => r.status === 0).map((r) => r.path);
  if (silent.length) {
    throw new HttpError(500, `Contrôle anti-fuite incomplet ${when}, ${after ? state : "version non publiée"}, site coupé par prudence : pas de réponse de nginx en 2 s sur ${silent.join(", ")}.`, "php_check");
  }
  const leaks = check.results.filter((r) => r.status !== 403 && r.status !== 404).map((r) => `${r.path} (${r.status})`);
  throw new HttpError(500, `Fuite détectée ${when}, ${state}, site coupé : ${leaks.join(", ")} répond(ent) au lieu d'être refusé(s).`, "php_leak");
}

/**
 * Publie une version d'un site PHP : réglages du site reposés, contrôle anti-fuite AVANT la bascule (il sonde les règles
 * de nginx, qui ne dépendent pas du contenu de la version), version envoyée si le CT ne l'a plus (sinon simple bascule :
 * retour arrière immédiat), puis second contrôle. Une version refusée ne reste jamais celle du CT : « Rallumer » ne la
 * relance pas (audit du 27/10/2026).
 */
export async function deployPhpVersion(services: Services, siteId: string, versionId: string): Promise<void> {
  const agent = agentOf(services);
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
  const version = await prisma.version.findFirstOrThrow({ where: { id: versionId, siteId }, include: { files: true } });
  if (version.status === "PURGED") throw new HttpError(409, "Version purgée : ses fichiers ne sont plus gardés.");
  await agent.upsertSite(specOf(site, services.sitesDomain));
  // Variables reposées à chaque publication : un CT reconstruit retrouve son .env sans autre geste.
  if (site.phpEnv) await agent.setEnv(site.slug, envOf(site));
  await prisma.version.update({ where: { id: versionId }, data: { status: "UPLOADING", error: null } });
  await leakGate(agent, site.slug);
  // Dump de la base avant la bascule (le nouveau code peut migrer le schéma) : restaurable avec la version.
  await agent.dumpBefore(site.slug, version.number);

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

  // Second contrôle, après la bascule : en cas de refus, la version servie avant (encore gardée sur le CT) est remise.
  const previous = site.currentVersionId && site.currentVersionId !== versionId
    ? await prisma.version.findUnique({ where: { id: site.currentVersionId }, select: { number: true } })
    : null;
  await leakGate(agent, site.slug, { previous: previous?.number ?? null });

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
        publicPersistentDirs: input.publicPersistentDirs ?? [],
        memoryLimitMb: input.memoryLimitMb,
        uploadMaxMb: input.uploadMaxMb,
        maxExecutionSec: input.maxExecutionSec,
      },
      { domain: services.sitesDomain, phpInstalled: () => installed },
    );
  } catch (err) {
    if (err instanceof OpError) throw new HttpError(400, err.message, "php_settings");
    throw err;
  }
}

