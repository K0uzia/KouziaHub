import type { OrphanFinding, OrphanReport } from "@/contract.js";
import { audit } from "@/lib/audit.js";
import { HUB_DNS_COMMENT_PREFIX, type CfDnsRecord, type CfProject, type CloudflareGateway } from "@/lib/cloudflare/types.js";
import { HttpError } from "@/lib/http.js";
import { PROJECTS_LIMIT } from "@/lib/limits.js";
import { prisma } from "@/lib/prisma.js";
import { PAGES_PROJECT_PREFIX } from "@/lib/slug.js";

/** Compteur de projets Pages du compte (tous projets), mis en cache quelques minutes. */
export class ProjectCounter {
  private cache: { at: number; count: number } | null = null;
  private inflight: Promise<number | null> | null = null;

  constructor(
    private readonly cloudflare: CloudflareGateway,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  readonly limit = PROJECTS_LIMIT;

  invalidate(): void {
    this.cache = null;
  }

  /** null si Cloudflare ne répond pas. */
  async used(): Promise<number | null> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.count;
    this.inflight ??= this.cloudflare
      .listProjects()
      .then((projects) => {
        this.cache = { at: Date.now(), count: projects.length };
        return projects.length;
      })
      .catch(() => null)
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}

type SiteRow = { id: string; slug: string; pagesProject: string; dnsRecordId: string | null; state: string };

function analyse(records: CfDnsRecord[], projects: CfProject[], sites: SiteRow[], sitesDomain: string): OrphanFinding[] {
  const findings: OrphanFinding[] = [];
  const sitesById = new Map(sites.map((s) => [s.id, s]));
  const projectNames = new Set(projects.map((p) => p.name));
  const projectTargets = new Set(projects.map((p) => p.subdomain.toLowerCase()));
  const sitesByProject = new Set(sites.map((s) => s.pagesProject));
  const recordIds = new Set(records.map((r) => r.id));

  for (const record of records) {
    const siteId = (record.comment ?? "").slice(HUB_DNS_COMMENT_PREFIX.length);
    const site = sitesById.get(siteId);
    const targetKnown = projectTargets.has(record.content.toLowerCase());
    if (!site) {
      findings.push({ type: "dns", name: record.name, detail: "Enregistrement DNS du hub sans site correspondant.", deletable: true });
    } else if (!targetKnown) {
      findings.push({ type: "dns", name: record.name, detail: `Pointe vers ${record.content}, absent du compte Cloudflare (risque de prise de contrôle).`, deletable: true });
    }
  }
  for (const project of projects) {
    if (project.name.startsWith(PAGES_PROJECT_PREFIX) && !sitesByProject.has(project.name)) {
      findings.push({ type: "project", name: project.name, detail: "Projet Pages « kz- » sans site dans le hub.", deletable: false });
    }
  }
  for (const site of sites) {
    if (site.state === "CREATING" || site.state === "DELETING") continue;
    if (!projectNames.has(site.pagesProject)) {
      findings.push({ type: "site", name: `${site.slug}.${sitesDomain}`, detail: `Projet ${site.pagesProject} absent chez Cloudflare.`, deletable: false });
    }
    if (site.dnsRecordId && !recordIds.has(site.dnsRecordId)) {
      findings.push({ type: "site", name: `${site.slug}.${sitesDomain}`, detail: "Enregistrement DNS attendu absent de la zone.", deletable: false });
    }
  }
  return findings;
}

function toReport(row: { checkedAt: Date; mode: string; findings: string; error: string | null } | null, mode: "real" | "fake"): OrphanReport {
  if (!row) return { checkedAt: null, mode, findings: [], error: null };
  let findings: OrphanFinding[] = [];
  try {
    findings = JSON.parse(row.findings) as OrphanFinding[];
  } catch {
    findings = [];
  }
  return { checkedAt: row.checkedAt.toISOString(), mode: row.mode === "real" ? "real" : "fake", findings, error: row.error };
}

/** Contrôle des orphelins : CNAME du hub, projets « kz- » et sites en base comparés. */
export class OrphanService {
  constructor(
    private readonly cloudflare: CloudflareGateway,
    private readonly sitesDomain: string,
  ) {}

  async latest(): Promise<OrphanReport> {
    const row = await prisma.orphanCheck.findFirst({ orderBy: { checkedAt: "desc" } });
    return toReport(row, this.cloudflare.mode);
  }

  private async findings(): Promise<OrphanFinding[]> {
    const [records, projects, sites] = await Promise.all([
      this.cloudflare.listHubDnsRecords(),
      this.cloudflare.listProjects(),
      prisma.site.findMany({ select: { id: true, slug: true, pagesProject: true, dnsRecordId: true, state: true } }),
    ]);
    return analyse(records, projects, sites, this.sitesDomain);
  }

  async check(): Promise<OrphanReport> {
    let findings: OrphanFinding[] = [];
    let error: string | null = null;
    try {
      findings = await this.findings();
    } catch (err) {
      error = `Contrôle impossible : ${err instanceof Error ? err.message : "erreur inconnue"}`;
    }
    const row = await prisma.orphanCheck.create({ data: { mode: this.cloudflare.mode, findings: JSON.stringify(findings), error } });
    // Seul le dernier résultat sert : l'historique ne grossit pas indéfiniment.
    await prisma.orphanCheck.deleteMany({ where: { checkedAt: { lt: new Date(Date.now() - 30 * 86_400_000) } } });
    return toReport(row, this.cloudflare.mode);
  }

  /** Supprime un CNAME orphelin, après un contrôle à jour qui le confirme. */
  async deleteDns(name: string): Promise<OrphanReport> {
    const hostname = name.trim().toLowerCase();
    const finding = (await this.findings()).find((f) => f.type === "dns" && f.deletable && f.name.toLowerCase() === hostname);
    if (!finding) throw new HttpError(409, "Cet enregistrement n'est pas (ou plus) orphelin : rien n'a été supprimé.");
    const record = await this.cloudflare.findDnsRecord(hostname);
    if (!record || !record.comment?.startsWith(HUB_DNS_COMMENT_PREFIX)) {
      throw new HttpError(409, "Enregistrement introuvable ou non créé par le hub : rien n'a été supprimé.");
    }
    await this.cloudflare.deleteDnsRecord(record.id);
    await audit({ action: "orphan.delete", result: "ok", siteSlug: hostname.split(".")[0] ?? null, detail: `CNAME ${hostname}` });
    return this.check();
  }
}
