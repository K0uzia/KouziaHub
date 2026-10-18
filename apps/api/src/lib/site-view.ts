import type { Operation as OperationRow, Site } from "@prisma/client";
import type { CatalogResponse, Notice, Operation, SiteDetail, SiteMonitorBadge, SiteSummary } from "@/contract.js";
import { siteBadges } from "@/lib/monitor/view.js";
import { prisma } from "@/lib/prisma.js";
import { findWaitingCertificateOp, parseSteps } from "@/lib/operations.js";
import { hostnameOf } from "@/lib/publish.js";
import type { Services } from "@/lib/services.js";
import { HttpError } from "@/lib/http.js";
import { serverConfigState } from "@/lib/server-config-store.js";

export function toOperation(op: OperationRow): Operation {
  return {
    id: op.id,
    kind: op.kind,
    status: op.status,
    steps: parseSteps(op.steps),
    error: op.error,
    startedAt: op.startedAt.toISOString(),
    finishedAt: op.finishedAt?.toISOString() ?? null,
  };
}

const latestOperation = (siteId: string) => prisma.operation.findFirst({ where: { siteId }, orderBy: { startedAt: "desc" } });

/**
 * Opération à montrer : en cours, dernière en échec, ou certificat encore attendu. `preloaded` : dernière
 * opération lue dans la même transaction que le site (sinon une écriture intercalée donnerait un état
 * incohérent, ex. opération en échec et domaine encore « en attente »).
 */
async function visibleOperation(site: Site, preloaded?: OperationRow | null): Promise<Operation | null> {
  const latest = preloaded !== undefined ? preloaded : await latestOperation(site.id);
  if (!latest) return null;
  if (latest.status === "RUNNING" || latest.status === "FAILED") return toOperation(latest);
  if (site.domainStatus === "PENDING" || site.domainStatus === "ERROR") {
    const waiting = await findWaitingCertificateOp(site.id);
    if (waiting) return toOperation(waiting);
  }
  return null;
}

type ErpNames = { names: Map<string, string>; available: boolean };

export async function erpNames(services: Services): Promise<ErpNames> {
  try {
    const clients = await services.erp.list();
    return { names: new Map(clients.map((c) => [c.id, c.displayName])), available: true };
  } catch {
    return { names: new Map(), available: false };
  }
}

export async function toSummary(
  site: Site,
  services: Services,
  erp: ErpNames,
  monitor: SiteMonitorBadge | null = null,
  latestOp?: OperationRow | null,
): Promise<SiteSummary> {
  const hostname = hostnameOf(site.slug, services.sitesDomain);
  const clientName = site.erpClientId ? (erp.names.get(site.erpClientId) ?? null) : null;
  const current = site.currentVersionId
    ? await prisma.version.findUnique({ where: { id: site.currentVersionId }, select: { id: true, number: true, publishedAt: true } })
    : null;
  return {
    id: site.id,
    slug: site.slug,
    hostname,
    url: `https://${hostname}`,
    kind: site.kind,
    name: site.label || clientName || hostname,
    label: site.label,
    erpClientId: site.erpClientId,
    clientName,
    state: site.state,
    domainStatus: site.domainStatus,
    operation: await visibleOperation(site, latestOp),
    workingDirty: site.workingDirty,
    currentVersion: current ? { id: current.id, number: current.number, publishedAt: current.publishedAt?.toISOString() ?? null } : null,
    thumbnailUrl: site.thumbnailPath && site.thumbnailAt ? `/api/sites/${site.id}/thumbnail?v=${site.thumbnailAt.getTime()}` : null,
    touchedAt: site.touchedAt.toISOString(),
    createdAt: site.createdAt.toISOString(),
    monitor,
  };
}

export function erpClientUrl(erpClientId: string | null): string | null {
  const origin = process.env.ERP_PUBLIC_ORIGIN?.trim().replace(/\/+$/, "");
  if (!erpClientId || !origin) return null;
  try {
    return new URL(`/clients/${encodeURIComponent(erpClientId)}`, `${new URL(origin).origin}/`).toString();
  } catch {
    return null;
  }
}

export async function siteDetail(siteId: string, services: Services): Promise<SiteDetail> {
  // Site et dernière opération lus ensemble (même instantané SQLite).
  const [site, latestOp] = await prisma.$transaction([prisma.site.findUnique({ where: { id: siteId } }), latestOperation(siteId)]);
  if (!site) throw new HttpError(404, "Site introuvable.");
  const erp = site.erpClientId ? await erpNames(services) : { names: new Map<string, string>(), available: true };
  const files = await prisma.workingFile.aggregate({ where: { siteId }, _count: { _all: true }, _sum: { size: true } });
  return {
    ...(await toSummary(site, services, erp, (await siteBadges(services.monitor, [site.id])).get(site.id) ?? null, latestOp)),
    pagesProject: site.pagesProject,
    pagesSubdomain: site.pagesSubdomain,
    erpClientUrl: erpClientUrl(site.erpClientId),
    thumbnailSource: site.thumbnailSource === "capture" || site.thumbnailSource === "upload" ? site.thumbnailSource : null,
    fileCount: files._count._all,
    totalBytes: files._sum.size ?? 0,
    finalDomain: site.finalDomain,
    canonicalHost: site.canonicalHost === "apex" ? "apex" : "www",
    notFoundPage: site.notFoundPage,
    serverConfig: await serverConfigState(site),
  };
}

export async function catalog(services: Services): Promise<CatalogResponse> {
  const [sites, erp, projectsUsed, orphans] = await Promise.all([
    prisma.site.findMany({ orderBy: { touchedAt: "desc" } }),
    erpNames(services),
    services.projects.used(),
    services.orphans.latest(),
  ]);
  const summaries: SiteSummary[] = [];
  const badges = await siteBadges(services.monitor, sites.map((s) => s.id));
  for (const site of sites) summaries.push(await toSummary(site, services, erp, badges.get(site.id) ?? null));

  const notices: Notice[] = [];
  if (services.cloudflare.mode === "fake") {
    notices.push({ level: "info", code: "cloudflare_fake", message: "Cloudflare simulé : aucun site n'est réellement créé ni publié." });
  }
  if (services.erp.mode === "fake") {
    notices.push({ level: "info", code: "erp_fake", message: "Clients de démonstration : l'ERP n'est pas relié." });
  } else if (!erp.available) {
    notices.push({ level: "warning", code: "erp_unavailable", message: "Clients de l'ERP indisponibles." });
  }
  if (orphans.findings.length > 0) {
    notices.push({ level: "warning", code: "orphans", message: `${orphans.findings.length} élément(s) orphelin(s) détecté(s) au dernier contrôle.` });
  }
  if (projectsUsed !== null && projectsUsed >= services.projects.limit - 10) {
    notices.push({
      level: projectsUsed >= services.projects.limit ? "error" : "warning",
      code: "projects_near_limit",
      message: `${projectsUsed} projets Pages sur ${services.projects.limit} : supprimer d'anciens sites avant d'en créer d'autres.`,
    });
  }

  return {
    sites: summaries,
    stats: {
      online: summaries.filter((s) => s.state === "ONLINE").length,
      offline: summaries.filter((s) => s.state === "OFFLINE").length,
      creating: summaries.filter((s) => s.state === "CREATING").length,
      errors: summaries.filter((s) => s.operation?.status === "FAILED" || s.domainStatus === "ERROR").length,
      projectsUsed,
      projectsLimit: services.projects.limit,
    },
    notices,
  };
}
