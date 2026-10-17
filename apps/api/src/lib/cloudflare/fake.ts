import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CloudflareError,
  HUB_DNS_COMMENT_PREFIX,
  type CfDeployment,
  type CfDnsRecord,
  type CfDomain,
  type CfProject,
  type CloudflareGateway,
  type DeployInput,
} from "@/lib/cloudflare/types.js";

type FakeDomain = { name: string; addedAt: number; status?: CfDomain["status"] };
type FakeDeployment = {
  id: string;
  url: string;
  manifest: Record<string, string>;
  workerJs: string;
  headersFile: string | null;
  redirectsFile: string | null;
  createdAt: number;
};
type FakeProject = { name: string; subdomain: string; domains: FakeDomain[]; deployments: FakeDeployment[] };
type FakeState = { projects: FakeProject[]; dns: CfDnsRecord[] };

export type FakeMethod = Exclude<keyof CloudflareGateway, "mode">;

export type FakeCloudflareOptions = {
  /** Fichier JSON de persistance (dev). Absent : en mémoire (tests). */
  file?: string;
  /** Délai simulé avant qu'un domaine ajouté passe « active ». Défaut 0. */
  activationDelayMs?: number;
  now?: () => number;
};

/**
 * Cloudflare simulé, sans aucun réseau : projets, domaines (« pending » puis « active » après un délai),
 * DNS et déploiements. Actif sans CLOUDFLARE_API_TOKEN. Les tests y injectent des erreurs et lisent
 * le journal des appels pour vérifier l'ordre des étapes.
 */
export class FakeCloudflare implements CloudflareGateway {
  readonly mode = "fake" as const;
  /** Journal « méthode:argument » des appels qui modifient l'état. */
  readonly calls: string[] = [];
  /** Noms de projet déjà pris ailleurs sur pages.dev : le sous-domaine reçoit un suffixe. */
  readonly takenSubdomains = new Set<string>();
  private readonly failures = new Map<FakeMethod, Error[]>();
  private state: FakeState = { projects: [], dns: [] };
  private readonly activationDelayMs: number;
  private readonly now: () => number;

  constructor(private readonly options: FakeCloudflareOptions = {}) {
    this.activationDelayMs = options.activationDelayMs ?? 0;
    this.now = options.now ?? Date.now;
    if (options.file) {
      try {
        this.state = JSON.parse(readFileSync(options.file, "utf8")) as FakeState;
      } catch {
        this.state = { projects: [], dns: [] };
      }
    }
  }

  /** La prochaine invocation de `method` échoue (une fois par appel à failNext). */
  failNext(method: FakeMethod, error: Error = new CloudflareError("Cloudflare simulé : erreur injectée.", 500)): void {
    const list = this.failures.get(method) ?? [];
    list.push(error);
    this.failures.set(method, list);
  }

  /** Projet hors hub (compte partagé avec d'autres projets). */
  seedProject(name: string): void {
    this.state.projects.push({ name, subdomain: `${name}.pages.dev`, domains: [], deployments: [] });
    this.save();
  }

  /** Projet supprimé hors hub (contrôle des orphelins). */
  dropProject(name: string): void {
    this.state.projects = this.state.projects.filter((p) => p.name !== name);
    this.save();
  }

  /** Enregistrement DNS créé hors hub. */
  seedDnsRecord(record: Omit<CfDnsRecord, "id"> & { id?: string }): CfDnsRecord {
    const full = { ...record, id: record.id ?? this.id() };
    this.state.dns.push(full);
    this.save();
    return full;
  }

  /** Force le statut d'un domaine (tests : erreur de validation). */
  setDomainStatus(project: string, hostname: string, status: CfDomain["status"]): void {
    const domain = this.project(project)?.domains.find((d) => d.name === hostname);
    if (domain) domain.status = status;
    this.save();
  }

  snapshot(): FakeState {
    return JSON.parse(JSON.stringify(this.state)) as FakeState;
  }

  deployments(project: string): FakeDeployment[] {
    return this.project(project)?.deployments ?? [];
  }

  private check(method: FakeMethod): void {
    const next = this.failures.get(method)?.shift();
    if (next) throw next;
  }

  private id(): string {
    return randomBytes(16).toString("hex");
  }

  private project(name: string): FakeProject | undefined {
    return this.state.projects.find((p) => p.name === name);
  }

  private save(): void {
    if (!this.options.file) return;
    mkdirSync(path.dirname(this.options.file), { recursive: true });
    const tmp = `${this.options.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.options.file);
  }

  private domainView(domain: FakeDomain): CfDomain {
    if (domain.status) return { name: domain.name, status: domain.status };
    const active = this.now() - domain.addedAt >= this.activationDelayMs;
    return { name: domain.name, status: active ? "active" : "pending" };
  }

  async createProject(name: string): Promise<CfProject> {
    this.check("createProject");
    const existing = this.project(name);
    if (existing) return { name: existing.name, subdomain: existing.subdomain };
    const subdomain = this.takenSubdomains.has(name) ? `${name}-${randomBytes(2).toString("hex")}.pages.dev` : `${name}.pages.dev`;
    this.state.projects.push({ name, subdomain, domains: [], deployments: [] });
    this.calls.push(`createProject:${name}`);
    this.save();
    return { name, subdomain };
  }

  async getProject(name: string): Promise<CfProject | null> {
    this.check("getProject");
    const p = this.project(name);
    return p ? { name: p.name, subdomain: p.subdomain } : null;
  }

  async listProjects(): Promise<CfProject[]> {
    this.check("listProjects");
    return this.state.projects.map((p) => ({ name: p.name, subdomain: p.subdomain }));
  }

  async deleteProject(name: string): Promise<void> {
    this.check("deleteProject");
    const p = this.project(name);
    if (!p) return;
    if (p.domains.length > 0) throw new CloudflareError("Cloudflare simulé : le projet a encore un domaine.", 400);
    this.state.projects = this.state.projects.filter((x) => x.name !== name);
    this.calls.push(`deleteProject:${name}`);
    this.save();
  }

  async addDomain(project: string, hostname: string): Promise<CfDomain> {
    this.check("addDomain");
    const p = this.project(project);
    if (!p) throw new CloudflareError("Projet Cloudflare introuvable.", 404);
    let domain = p.domains.find((d) => d.name === hostname);
    if (!domain) {
      domain = { name: hostname, addedAt: this.now() };
      p.domains.push(domain);
      this.calls.push(`addDomain:${hostname}`);
      this.save();
    }
    return this.domainView(domain);
  }

  async getDomain(project: string, hostname: string): Promise<CfDomain | null> {
    this.check("getDomain");
    const domain = this.project(project)?.domains.find((d) => d.name === hostname);
    return domain ? this.domainView(domain) : null;
  }

  async removeDomain(project: string, hostname: string): Promise<void> {
    this.check("removeDomain");
    const p = this.project(project);
    if (!p || !p.domains.some((d) => d.name === hostname)) return;
    p.domains = p.domains.filter((d) => d.name !== hostname);
    this.calls.push(`removeDomain:${hostname}`);
    this.save();
  }

  async findDnsRecord(hostname: string): Promise<CfDnsRecord | null> {
    this.check("findDnsRecord");
    return this.state.dns.find((r) => r.name === hostname) ?? null;
  }

  async createCname(hostname: string, target: string, comment: string): Promise<CfDnsRecord> {
    this.check("createCname");
    if (this.state.dns.some((r) => r.name === hostname)) {
      throw new CloudflareError("Un enregistrement DNS existe déjà pour ce nom.", 400, 81053);
    }
    const record: CfDnsRecord = { id: this.id(), type: "CNAME", name: hostname, content: target, proxied: true, comment };
    this.state.dns.push(record);
    this.calls.push(`createCname:${hostname}`);
    this.save();
    return record;
  }

  async deleteDnsRecord(id: string): Promise<void> {
    this.check("deleteDnsRecord");
    const record = this.state.dns.find((r) => r.id === id);
    if (!record) return;
    this.state.dns = this.state.dns.filter((r) => r.id !== id);
    this.calls.push(`deleteDnsRecord:${record.name}`);
    this.save();
  }

  async listHubDnsRecords(): Promise<CfDnsRecord[]> {
    this.check("listHubDnsRecords");
    return this.state.dns.filter((r) => r.comment?.startsWith(HUB_DNS_COMMENT_PREFIX));
  }

  async deploy(project: string, input: DeployInput): Promise<CfDeployment> {
    this.check("deploy");
    const p = this.project(project);
    if (!p) throw new CloudflareError("Projet Cloudflare introuvable.", 404);
    const manifest: Record<string, string> = {};
    for (const file of input.files) {
      const content = await file.read();
      if (content.length !== file.size) throw new CloudflareError("Cloudflare simulé : taille de fichier incohérente.", 400);
      manifest[`/${file.path}`] = file.sha256;
    }
    const id = this.id();
    const deployment: FakeDeployment = {
      id,
      url: `https://${id.slice(0, 8)}.${p.subdomain}`,
      manifest,
      workerJs: input.workerJs,
      headersFile: input.headersFile ?? null,
      redirectsFile: input.redirectsFile ?? null,
      createdAt: this.now(),
    };
    p.deployments.push(deployment);
    this.calls.push(`deploy:${project}`);
    this.save();
    return { id, url: deployment.url };
  }

  async deleteDeployment(project: string, id: string): Promise<void> {
    this.check("deleteDeployment");
    const p = this.project(project);
    if (!p || !p.deployments.some((d) => d.id === id)) return;
    if (p.deployments[p.deployments.length - 1]!.id === id) {
      throw new CloudflareError("Le dernier déploiement de la branche ne peut pas être supprimé.", 400);
    }
    p.deployments = p.deployments.filter((d) => d.id !== id);
    this.calls.push(`deleteDeployment:${id}`);
    this.save();
  }
}
