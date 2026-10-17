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

/** ERP HTTP si ERP_BASE_URL est posée (secret obligatoire), sinon clients de démonstration. */
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
    thumbnails: new ThumbnailService({ dataDir, blobs, chromiumPath: overrides.chromiumPath }),
    projects: new ProjectCounter(cloudflare),
    orphans: new OrphanService(cloudflare, sitesDomain),
  } as Services;
  services.engine = new OperationEngine(services);
  services.domains = new DomainWatcher(services, overrides.domainWatcher);
  services.timers = [];
  services.close = async () => {
    for (const t of services.timers) clearTimeout(t);
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
  const run = () => void services.orphans.check().catch((err) => console.error("[orphelins] contrôle impossible", err instanceof Error ? err.message : err));
  const first = setTimeout(run, 60_000);
  const daily = setInterval(run, DAY_MS);
  const gc = setInterval(() => void services.blobs.gc().catch(() => undefined), DAY_MS);
  for (const t of [first, daily, gc]) t.unref();
  services.timers.push(first, daily, gc);
}
