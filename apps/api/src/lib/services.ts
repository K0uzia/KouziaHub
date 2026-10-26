import path from "node:path";
import { BlobStore } from "@/lib/blobs.js";
import { FakeCloudflare } from "@/lib/cloudflare/fake.js";
import { RealCloudflare } from "@/lib/cloudflare/real.js";
import type { CloudflareGateway } from "@/lib/cloudflare/types.js";
import { getDataDir, getSitesDomain } from "@/lib/env.js";
import { FakeErpDirectory } from "@/lib/erp/fake.js";
import { HttpErpDirectory } from "@/lib/erp/http.js";
import type { ErpDirectory } from "@/lib/erp/types.js";
import { DomainWatcher, OperationEngine, type DomainWatcherOptions } from "@/lib/operations.js";
import { OrphanService, ProjectCounter } from "@/lib/orphans.js";
import { ThumbnailService } from "@/lib/thumbnails.js";
import { zonesFromEnv, type ZonesDirectory } from "@/lib/cloudflare/zones.js";
import { MonitorService, type MonitorDeps } from "@/lib/monitor/service.js";
import { veilleFromEnv } from "@/lib/monitor/worker-client.js";
import { PushService } from "@/lib/push/service.js";
import { generateReport, reportContext } from "@/lib/monitor/report.js";
import { prisma } from "@/lib/prisma.js";
import { backfillSiteTargets } from "@/lib/monitor/targets.js";
import { phpAgentFromEnv, type PhpAgentClient } from "@/lib/php-agent/client.js";
import { startPhpBackups } from "@/lib/php-app.js";
import { phpDnsTarget } from "@/lib/php-sites.js";
import { smtpSender, type MailSender } from "@/lib/mailer.js";
import { ForwardLimiter, startPhpMailRedirect } from "@/lib/php-mails.js";

export type Services = {
  cloudflare: CloudflareGateway;
  erp: ErpDirectory;
  blobs: BlobStore;
  dataDir: string;
  sitesDomain: string;
  engine: OperationEngine;
  domains: DomainWatcher;
  thumbnails: ThumbnailService;
  projects: ProjectCounter;
  orphans: OrphanService;
  /** Surveillance des sites (cadrage section 10) et notifications Web Push. */
  monitor: MonitorService;
  push: PushService;
  /** Zones Cloudflare (jeton séparé en lecture seule) pour proposer des cibles. */
  zones: ZonesDirectory;
  /** Agent du CT des sites PHP (docs/cadrage.md, section 11), null tant qu'il n'est pas posé. */
  phpAgent: PhpAgentClient | null;
  /** Remise des e-mails capturés par le SMTP du hub (lot P5), et son débit par site. */
  mailSender: MailSender;
  mailLimiter: ForwardLimiter;
  /** Minuteries des tâches de fond (startBackground). */
  timers: NodeJS.Timeout[];
  /** Arrête les minuteries et sondages, attend les opérations en cours (borné). */
  close(): Promise<void>;
};

export type ServicesOverrides = {
  cloudflare?: CloudflareGateway;
  erp?: ErpDirectory;
  dataDir?: string;
  sitesDomain?: string;
  domainWatcher?: DomainWatcherOptions;
  /** null : capture coupée ; undefined : HUB_CHROMIUM_PATH ou Chromium de playwright-core. */
  chromiumPath?: string | null;
  /** Surveillance : Worker, fetch, TLS, DNS, RDAP, vitesse et horloge injectables (tests). */
  monitor?: Partial<MonitorDeps>;
  push?: PushService;
  zones?: ZonesDirectory;
  phpAgent?: PhpAgentClient | null;
  mailSender?: MailSender;
};

/** Cloudflare réel si un jeton est posé, sinon simulé (persisté dans HUB_DATA_DIR/fake-cloudflare.json). */
export function cloudflareFromEnv(dataDir: string): CloudflareGateway {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) {
    // Délai de certificat simulé : l'interface montre l'attente comme en réel.
    return new FakeCloudflare({ file: path.join(dataDir, "fake-cloudflare.json"), activationDelayMs: 20_000 });
  }
  return new RealCloudflare({
    token,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "",
    zoneId: process.env.CLOUDFLARE_ZONE_ID?.trim() ?? "",
  });
}

/** ERP HTTP si ERP_BASE_URL est posée (secret obligatoire), sinon clients d'exemple. */
export function erpFromEnv(): ErpDirectory {
  const baseUrl = process.env.ERP_BASE_URL?.trim();
  if (!baseUrl) return new FakeErpDirectory();
  const secret = process.env.HUB_READ_SECRET?.trim();
  if (!secret) throw new Error("ERP_BASE_URL posée sans HUB_READ_SECRET : secret partagé avec l'ERP requis.");
  return new HttpErpDirectory({ baseUrl, secret });
}

export function createServices(overrides: ServicesOverrides = {}): Services {
  const dataDir = overrides.dataDir ?? getDataDir();
  const sitesDomain = overrides.sitesDomain ?? getSitesDomain();
  const cloudflare = overrides.cloudflare ?? cloudflareFromEnv(dataDir);
  const blobs = new BlobStore(dataDir);
  const services = {
    cloudflare,
    erp: overrides.erp ?? erpFromEnv(),
    blobs,
    dataDir,
    sitesDomain,
    // Sites PHP : pages lues par l'agent (posé plus bas, lu à la capture).
    thumbnails: new ThumbnailService({ dataDir, blobs, chromiumPath: overrides.chromiumPath, sitesDomain, phpPages: () => services.phpAgent }),
    projects: new ProjectCounter(cloudflare),
    // Cible des CNAME des sites PHP, lue à la demande (l'agent est posé plus bas).
    orphans: new OrphanService(cloudflare, sitesDomain, () => (services.phpAgent ? phpDnsTarget(services) : Promise.resolve(null))),
  } as Services;
  services.push = overrides.push ?? new PushService();
  services.zones = overrides.zones ?? zonesFromEnv();
  services.phpAgent = overrides.phpAgent !== undefined ? overrides.phpAgent : phpAgentFromEnv();
  services.monitor = new MonitorService({
    push: services.push,
    veille: overrides.monitor?.veille ?? veilleFromEnv(),
    chromiumPath: overrides.chromiumPath,
    dataDir,
    ...overrides.monitor,
  });
  services.monitor.monthlyReports = async (month) => {
    for (const target of await prisma.monitorTarget.findMany({ where: { enabled: true } })) {
      await reportContext(services.erp, target)
        .then((ctx) => generateReport(dataDir, target, month, services.monitor.now(), ctx))
        .catch((err) =>
        console.error("[surveillance] rapport impossible", err instanceof Error ? err.message : err),
      );
    }
  };
  services.mailSender = overrides.mailSender ?? smtpSender;
  services.mailLimiter = new ForwardLimiter();
  services.engine = new OperationEngine(services);
  services.domains = new DomainWatcher(services, overrides.domainWatcher);
  services.timers = [];
  services.close = async () => {
    for (const t of services.timers) clearTimeout(t);
    await services.monitor.stop();
    services.domains.close();
    await Promise.race([services.engine.idle(), new Promise((r) => setTimeout(r, 2000).unref())]);
  };
  return services;
}

const DAY_MS = 86_400_000;

/**
 * Tâches de fond du serveur (pas des tests) : opérations interrompues marquées en échec, reprise du
 * sondage des certificats, contrôle des orphelins une minute après le démarrage puis chaque jour.
 */
export async function startBackground(services: Services): Promise<void> {
  const interrupted = await services.engine.recoverInterrupted();
  if (interrupted > 0) console.warn(`[démarrage] ${interrupted} opération(s) interrompue(s), à reprendre depuis le hub`);
  await services.domains.resumeAll();
  const run = (failClosed: boolean) => () =>
    void services.orphans.check({ failClosed }).catch((err) => console.error("[orphelins] contrôle impossible", err instanceof Error ? err.message : err));
  // Après le démarrage : orphelins seulement ; le réglage « fail closed » est vérifié au contrôle quotidien.
  const first = setTimeout(run(false), 60_000);
  const daily = setInterval(run(true), DAY_MS);
  const gc = setInterval(() => void services.blobs.gc().catch(() => undefined), DAY_MS);
  for (const t of [first, daily, gc]) t.unref();
  services.timers.push(first, daily, gc);
  // Bases des sites PHP : export de nuit, rangé dans les données du hub (incluses dans sa sauvegarde chiffrée).
  services.timers.push(startPhpBackups(services));
  // E-mails capturés : redirection vers les adresses autorisées des sites qui l'ont activée, chaque minute.
  services.timers.push(startPhpMailRedirect({ services, sender: services.mailSender, limiter: services.mailLimiter }));
  const backfilled = await backfillSiteTargets(services.sitesDomain).catch((err) => {
    console.error("[surveillance] rattrapage des cibles impossible", err instanceof Error ? err.message : err);
    return 0;
  });
  if (backfilled > 0) console.warn(`[démarrage] cibles de surveillance ajoutées ou mises à jour pour ${backfilled} site(s)`);
  // start() envoie la configuration au Worker (/sync), cibles rattrapées comprises.
  services.monitor.start();
}
