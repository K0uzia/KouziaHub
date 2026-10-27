import { hostingOf, pagesProjectOf, type Hosting } from "@/lib/site-hosting.js";
import { agentOf, phpDnsTarget, specOf } from "@/lib/php-sites.js";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { Operation, OperationKind, Site } from "@prisma/client";
import type { OperationStep } from "@/contract.js";
import { audit } from "@/lib/audit.js";
import { CloudflareError, HUB_DNS_COMMENT_PREFIX, type CfDomain } from "@/lib/cloudflare/types.js";
import { HttpError } from "@/lib/http.js";
import { PhpAgentOpError, PhpAgentUnavailableError } from "@/lib/php-agent/client.js";
import { PLACEHOLDER_HTML } from "@/lib/placeholder.js";
import { prisma } from "@/lib/prisma.js";
import { applyRetention, createVersion, deployVersion, hostnameOf } from "@/lib/publish.js";
import type { Services } from "@/lib/services.js";
import { recalibrateContent } from "@/lib/monitor/targets.js";

/** Erreur d'étape au message affichable tel quel. */
export class StepError extends Error {}

type StepOutcome = void | { waiting: string } | { detail: string };

type StepContext = {
  services: Services;
  op: Operation;
  params: Record<string, unknown>;
  site: Site;
  hostname: string;
};

type StepDef = { key: string; label: string; run: (ctx: StepContext) => Promise<StepOutcome> };

export const CERT_WAITING = "certificat en cours, quelques minutes";
export const INTERRUPTED = "Opération interrompue (redémarrage du serveur) : reprendre.";

export const hubDnsComment = (siteId: string) => `${HUB_DNS_COMMENT_PREFIX}${siteId}`;

const isDomainError = (status: CfDomain["status"]) => status === "error" || status === "blocked";
const domainStatusOf = (status: CfDomain["status"]) => (status === "active" ? "ACTIVE" : isDomainError(status) ? "ERROR" : "PENDING");

const projectStep: StepDef = {
  key: "project",
  label: "Projet Cloudflare créé",
  async run({ services, site }) {
    const project = await services.cloudflare.createProject(pagesProjectOf(site));
    await prisma.site.update({ where: { id: site.id }, data: { pagesSubdomain: project.subdomain } });
    services.projects.invalidate();
  },
};

const placeholderStep: StepDef = {
  key: "placeholder",
  label: "Page d'attente publiée",
  async run({ services, site }) {
    if (site.currentVersionId) return;
    let version = await prisma.version.findFirst({
      where: { siteId: site.id, source: "placeholder", status: { in: ["UPLOADING", "FAILED"] } },
      orderBy: { number: "desc" },
    });
    if (!version) {
      const blob = await services.blobs.putBuffer(Buffer.from(PLACEHOLDER_HTML, "utf8"));
      // Site PHP : la page d'attente va dans son dossier public (seul servi).
      const page = hostingOf(site) === "php" && site.phpPublicDir ? `${site.phpPublicDir}/index.html` : "index.html";
      version = await createVersion(site.id, "placeholder", [{ path: page, ...blob }], { note: "Page d'attente" });
    }
    await deployVersion(services, site.id, version.id);
  },
};

const domainAddStep: StepDef = {
  key: "domain",
  label: "Adresse ajoutée au projet",
  async run({ services, site, hostname }) {
    const domain = await services.cloudflare.addDomain(pagesProjectOf(site), hostname);
    await prisma.site.update({ where: { id: site.id }, data: { domainStatus: domainStatusOf(domain.status) } });
  },
};

const dnsAddStep: StepDef = {
  key: "dns",
  label: "Enregistrement DNS créé",
  async run({ services, site, hostname }) {
    const comment = hubDnsComment(site.id);
    // Cible : l'adresse pages.dev du projet (site Pages) ou le tunnel du CT des sites PHP (site PHP).
    const target = hostingOf(site) === "php" ? await phpDnsTarget(services) : site.pagesSubdomain;
    const existing = await services.cloudflare.findDnsRecord(hostname);
    if (existing) {
      if (existing.comment === comment) {
        if (!target) throw new StepError("adresse pages.dev inconnue : reprendre la création du projet.");
        // CNAME du hub réemployé : sa cible doit être la cible actuelle, sinon il est recalé.
        const stale = existing.type !== "CNAME" || existing.content.toLowerCase() !== target.toLowerCase() || !existing.proxied;
        if (stale) await services.cloudflare.updateCname(existing.id, hostname, target, comment);
        await prisma.site.update({ where: { id: site.id }, data: { dnsRecordId: existing.id } });
        return;
      }
      throw new StepError(`un enregistrement DNS ${existing.type} existe déjà pour ${hostname} hors du hub : le retirer dans Cloudflare, puis reprendre.`);
    }
    if (!target) throw new StepError("adresse pages.dev inconnue : reprendre la création du projet.");
    const record = await services.cloudflare.createCname(hostname, target, comment);
    await prisma.site.update({ where: { id: site.id }, data: { dnsRecordId: record.id } });
  },
};

const certificateStep: StepDef = {
  key: "certificate",
  label: "Certificat HTTPS",
  async run({ services, site, hostname }) {
    const domain = await services.cloudflare.getDomain(pagesProjectOf(site), hostname);
    if (!domain) throw new StepError("adresse absente du projet Cloudflare : reprendre l'opération.");
    if (domain.status === "active") {
      await prisma.site.update({ where: { id: site.id }, data: { domainStatus: "ACTIVE", state: "ONLINE" } });
      return;
    }
    if (isDomainError(domain.status)) {
      await prisma.site.update({ where: { id: site.id }, data: { domainStatus: "ERROR" } });
      throw new StepError("Cloudflare signale une erreur de validation de l'adresse.");
    }
    await prisma.site.update({ where: { id: site.id }, data: { domainStatus: "PENDING" } });
    services.domains.watch(site.id);
    return { waiting: CERT_WAITING };
  },
};

const dnsRemoveStep: StepDef = {
  key: "dns",
  label: "Enregistrement DNS supprimé",
  async run({ services, site, hostname }) {
    if (site.dnsRecordId) await services.cloudflare.deleteDnsRecord(site.dnsRecordId);
    const leftover = await services.cloudflare.findDnsRecord(hostname);
    if (leftover && leftover.comment === hubDnsComment(site.id)) await services.cloudflare.deleteDnsRecord(leftover.id);
    await prisma.site.update({ where: { id: site.id }, data: { dnsRecordId: null } });
  },
};

const domainRemoveStep: StepDef = {
  key: "domain",
  label: "Adresse retirée du projet",
  async run({ services, site, hostname }) {
    services.domains.unwatch(site.id);
    await services.cloudflare.removeDomain(pagesProjectOf(site), hostname);
    await prisma.site.update({ where: { id: site.id }, data: { domainStatus: "NONE" } });
  },
};

const offlineStep: StepDef = {
  key: "offline",
  label: "Site hors ligne",
  async run({ site }) {
    await prisma.site.update({ where: { id: site.id }, data: { state: "OFFLINE", touchedAt: new Date() } });
  },
};

const projectDeleteStep: StepDef = {
  key: "project",
  label: "Projet Cloudflare supprimé",
  async run({ services, site }) {
    await services.cloudflare.deleteProject(pagesProjectOf(site));
    services.projects.invalidate();
  },
};

const localDeleteStep: StepDef = {
  key: "local",
  label: "Données locales supprimées",
  async run({ services, site }) {
    if (site.thumbnailPath) await rm(path.join(services.dataDir, site.thumbnailPath), { force: true });
    // Operation.siteId passe à null (SetNull) ; l'historique reste lisible par siteSlug.
    await prisma.site.delete({ where: { id: site.id } });
    void services.blobs.gc().catch(() => undefined);
  },
};

const uploadStep: StepDef = {
  key: "upload",
  label: "Fichiers envoyés à Cloudflare",
  async run({ services, site, params }) {
    const versionId = typeof params.versionId === "string" ? params.versionId : null;
    if (!versionId) throw new StepError("version à publier inconnue.");
    await deployVersion(services, site.id, versionId);
  },
};

const retentionStep: StepDef = {
  key: "retention",
  label: "Anciennes versions purgées",
  async run({ services, site }) {
    const { purged, failed } = await applyRetention(services, site.id);
    if (failed > 0) return { detail: `${purged} purgée(s), ${failed} à reprendre au prochain envoi` };
    return purged > 0 ? { detail: `${purged} purgée(s)` } : undefined;
  },
};

// --- Sites PHP (docs/cadrage.md, section 11) : agent du CT au lieu du projet Pages ---

const phpSiteStep: StepDef = {
  key: "php-site",
  label: "Site posé sur le serveur PHP",
  async run({ services, site }) {
    await agentOf(services).upsertSite(specOf(site, services.sitesDomain));
  },
};

const phpEnableStep: StepDef = {
  key: "php-enable",
  label: "Site rallumé sur le serveur PHP",
  async run({ services, site }) {
    await agentOf(services).setEnabled(site.slug, true);
  },
};

const phpDisableStep: StepDef = {
  key: "php-disable",
  label: "Site coupé sur le serveur PHP",
  async run({ services, site }) {
    await agentOf(services).setEnabled(site.slug, false);
    // Plus d'adresse servie : même état que la coupure d'un site Pages (domaine retiré).
    await prisma.site.update({ where: { id: site.id }, data: { domainStatus: "NONE" } });
  },
};

const phpRemoveStep: StepDef = {
  key: "php-remove",
  label: "Site retiré du serveur PHP",
  async run({ services, site }) {
    try {
      await agentOf(services).removeSite(site.slug);
    } catch (err) {
      // Déjà absent du CT (création arrêtée avant, ou suppression faite dont la réponse s'est perdue) : le but est
      // atteint. Sans cela, chaque reprise échouait et le site restait « en suppression » (audit du 27/10/2026).
      if (!(err instanceof PhpAgentOpError && err.status === 404)) throw err;
    }
  },
};

// Certificat : celui de Cloudflare sur la zone (le tunnel sert l'adresse tout de suite), aucune attente.
const phpOnlineStep: StepDef = {
  key: "online",
  label: "Site en ligne",
  async run({ site }) {
    await prisma.site.update({ where: { id: site.id }, data: { domainStatus: "ACTIVE", state: "ONLINE", touchedAt: new Date() } });
  },
};

const PHP_OPERATION_STEPS: Record<OperationKind, StepDef[]> = {
  CREATE: [phpSiteStep, placeholderStep, dnsAddStep, phpOnlineStep],
  ENABLE: [phpEnableStep, dnsAddStep, phpOnlineStep],
  // Ordre anti-orphelin, comme pour Pages : CNAME d'abord, puis le site sur le CT.
  DISABLE: [dnsRemoveStep, phpDisableStep, offlineStep],
  DELETE: [dnsRemoveStep, phpRemoveStep, localDeleteStep],
  PUBLISH: [{ ...uploadStep, label: "Fichiers envoyés au serveur des sites PHP" }, retentionStep],
};

export const OPERATION_STEPS: Record<OperationKind, StepDef[]> = {
  CREATE: [projectStep, placeholderStep, domainAddStep, dnsAddStep, certificateStep],
  ENABLE: [domainAddStep, dnsAddStep, certificateStep],
  DISABLE: [dnsRemoveStep, domainRemoveStep, offlineStep],
  // Ordre anti-orphelin : CNAME, puis domaine, puis projet, puis données locales.
  DELETE: [dnsRemoveStep, domainRemoveStep, projectDeleteStep, localDeleteStep],
  PUBLISH: [uploadStep, retentionStep],
};

/** Étapes d'une opération selon l'hébergement du site. */
export function stepsFor(kind: OperationKind, hosting: Hosting): StepDef[] {
  return (hosting === "php" ? PHP_OPERATION_STEPS : OPERATION_STEPS)[kind];
}

const AUDIT_ACTION: Record<OperationKind, string> = {
  CREATE: "site.create",
  ENABLE: "site.enable",
  DISABLE: "site.disable",
  DELETE: "site.delete",
  PUBLISH: "version.publish",
};

export function parseSteps(raw: string): OperationStep[] {
  try {
    const steps = JSON.parse(raw) as OperationStep[];
    return Array.isArray(steps) ? steps : [];
  } catch {
    return [];
  }
}

function displayableError(err: unknown): string {
  if (err instanceof StepError || err instanceof CloudflareError || err instanceof HttpError) return err.message;
  // Refus ou silence de l'agent du CT PHP : son message dit la cause (réglage, site absent, injoignable).
  if (err instanceof PhpAgentOpError || err instanceof PhpAgentUnavailableError) return err.message;
  console.error("[opération] erreur inattendue", err);
  return "erreur inattendue (voir le journal du serveur).";
}

/**
 * Moteur d'opérations en processus : une seule opération en cours par site, exécutée en arrière-plan,
 * état écrit en base à chaque étape. Une étape vérifie avant de créer : la reprise repart de l'étape
 * en échec sans rien dupliquer.
 */
export class OperationEngine {
  private readonly busy = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();

  constructor(private readonly services: Services) {}

  async start(siteId: string, kind: OperationKind, params: Record<string, unknown> = {}): Promise<Operation> {
    if (this.busy.has(siteId)) throw new HttpError(409, "Une opération est déjà en cours sur ce site.", "operation_running");
    this.busy.add(siteId);
    try {
      const running = await prisma.operation.findFirst({ where: { siteId, status: "RUNNING" }, select: { id: true } });
      if (running) throw new HttpError(409, "Une opération est déjà en cours sur ce site.", "operation_running");
      const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
      const steps: OperationStep[] = stepsFor(kind, hostingOf(site)).map((s) => ({ key: s.key, label: s.label, status: "todo" }));
      const op = await prisma.operation.create({
        data: { siteId, siteSlug: site.slug, kind, steps: JSON.stringify(steps), params: JSON.stringify(params) },
      });
      this.launch(op.id, siteId);
      return op;
    } catch (err) {
      this.busy.delete(siteId);
      throw err;
    }
  }

  async retry(siteId: string, opId: string): Promise<Operation> {
    // Verrou posé avant tout await, comme start() : deux reprises simultanées ne lancent qu'une exécution.
    if (this.busy.has(siteId)) throw new HttpError(409, "Une opération est déjà en cours sur ce site.", "operation_running");
    this.busy.add(siteId);
    try {
      const op = await prisma.operation.findFirst({ where: { id: opId, siteId } });
      if (!op) throw new HttpError(404, "Opération introuvable.");
      if (op.status !== "FAILED") throw new HttpError(409, "Seule une opération en échec peut être reprise.");
      const latest = await prisma.operation.findFirst({ where: { siteId }, orderBy: { startedAt: "desc" }, select: { id: true } });
      if (latest?.id !== op.id) throw new HttpError(409, "Une opération plus récente a eu lieu sur ce site : relancer l'action.");
      const steps = parseSteps(op.steps).map((s) => (s.status === "failed" || s.status === "running" ? { key: s.key, label: s.label, status: "todo" as const } : s));
      const updated = await prisma.operation.update({
        where: { id: op.id },
        data: { status: "RUNNING", error: null, finishedAt: null, steps: JSON.stringify(steps) },
      });
      this.launch(op.id, siteId);
      return updated;
    } catch (err) {
      this.busy.delete(siteId);
      throw err;
    }
  }

  private launch(opId: string, siteId: string): void {
    const task = this.run(opId)
      .catch((err) => console.error("[opération] échec du moteur", err))
      .finally(() => {
        this.busy.delete(siteId);
        this.tasks.delete(task);
      });
    this.tasks.add(task);
  }

  /** Attend la fin des opérations en cours (tests, arrêt). */
  async idle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
  }

  isBusy(siteId: string): boolean {
    return this.busy.has(siteId);
  }

  /**
   * Verrou du site hors opération (purge, export) : même verrou que les opérations, une seule action à la
   * fois. Renvoie la fonction qui le rend ; 409 si le site est déjà occupé.
   */
  async acquire(siteId: string): Promise<() => void> {
    if (this.busy.has(siteId)) throw new HttpError(409, "Une opération est en cours sur ce site : réessayez à la fin.", "operation_running");
    this.busy.add(siteId);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.busy.delete(siteId);
    };
    try {
      const running = await prisma.operation.findFirst({ where: { siteId, status: "RUNNING" }, select: { id: true } });
      if (running) throw new HttpError(409, "Une opération est en cours sur ce site : réessayez à la fin.", "operation_running");
    } catch (err) {
      release();
      throw err;
    }
    return release;
  }

  async withLock<T>(siteId: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(siteId);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async run(opId: string): Promise<void> {
    const op = await prisma.operation.findUniqueOrThrow({ where: { id: opId } });
    // Hébergement lu au départ (le site peut disparaître à la dernière étape d'une suppression).
    const hosting = op.siteId ? await prisma.site.findUnique({ where: { id: op.siteId }, select: { hosting: true } }) : null;
    const defs = stepsFor(op.kind, hosting ? hostingOf(hosting) : "pages");
    const steps = parseSteps(op.steps);
    const params = op.params ? (JSON.parse(op.params) as Record<string, unknown>) : {};
    const save = (data: Partial<Pick<Operation, "status" | "error" | "finishedAt">> = {}) =>
      prisma.operation.update({ where: { id: opId }, data: { steps: JSON.stringify(steps), ...data } });

    for (let i = 0; i < defs.length; i++) {
      const def = defs[i]!;
      const step = steps[i] ?? { key: def.key, label: def.label, status: "todo" as const };
      steps[i] = step;
      if (step.status === "done" || step.status === "waiting") continue;
      step.status = "running";
      delete step.detail;
      await save();
      try {
        const site = op.siteId ? await prisma.site.findUnique({ where: { id: op.siteId } }) : null;
        if (!site) throw new StepError("site introuvable.");
        const outcome = await def.run({
          services: this.services,
          op,
          params,
          site,
          hostname: hostnameOf(site.slug, this.services.sitesDomain),
        });
        if (outcome && "waiting" in outcome) {
          step.status = "waiting";
          step.detail = outcome.waiting;
        } else {
          step.status = "done";
          if (outcome && "detail" in outcome) step.detail = outcome.detail;
        }
      } catch (err) {
        const message = displayableError(err);
        step.status = "failed";
        step.detail = message;
        await save({ status: "FAILED", error: `${def.label} : ${message}`, finishedAt: new Date() });
        await audit({ action: AUDIT_ACTION[op.kind], result: "error", siteId: op.siteId, siteSlug: op.siteSlug, detail: `${def.label} : ${message}` });
        return;
      }
    }
    await save({ status: "DONE", error: null, finishedAt: new Date() });
    const stillThere = op.siteId ? await prisma.site.findUnique({ where: { id: op.siteId }, select: { id: true } }) : null;
    await audit({
      action: params.republishOf ? "version.republish" : AUDIT_ACTION[op.kind],
      result: "ok",
      siteId: stillThere ? op.siteId : null,
      siteSlug: op.siteSlug,
      detail: typeof params.versionNumber === "number" ? `version ${params.versionNumber}` : null,
    });
    if (op.kind === "PUBLISH" && stillThere) {
      this.services.thumbnails.enqueue(op.siteId!, { auto: true });
      await recalibrateContent(op.siteId!, (sha) => this.services.blobs.read(sha)).catch(() => undefined);
    }
    // Cibles actives changées (site en ligne, coupé, supprimé) : configuration du Worker à jour.
    void this.services.monitor.requestSync();
  }

  /** Démarrage : une opération restée RUNNING (arrêt du serveur) passe en échec, à reprendre. */
  async recoverInterrupted(): Promise<number> {
    const running = await prisma.operation.findMany({ where: { status: "RUNNING" } });
    for (const op of running) {
      const steps = parseSteps(op.steps).map((s) => (s.status === "running" ? { ...s, status: "failed" as const, detail: INTERRUPTED } : s));
      await prisma.operation.update({
        where: { id: op.id },
        data: { status: "FAILED", error: INTERRUPTED, finishedAt: new Date(), steps: JSON.stringify(steps) },
      });
    }
    await prisma.version.updateMany({ where: { status: "UPLOADING" }, data: { status: "FAILED", error: INTERRUPTED } });
    return running.length;
  }
}

/** Dernière opération CREATE ou ENABLE dont l'étape « Certificat HTTPS » attend encore. */
export async function findWaitingCertificateOp(siteId: string): Promise<Operation | null> {
  const ops = await prisma.operation.findMany({
    where: { siteId, kind: { in: ["CREATE", "ENABLE"] }, status: "DONE" },
    orderBy: { startedAt: "desc" },
    take: 1,
  });
  const op = ops[0];
  return op && parseSteps(op.steps).some((s) => s.key === "certificate" && s.status === "waiting") ? op : null;
}

const abortableSleep =(ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

export type DomainWatcherOptions = {
  /** Délais successifs entre deux sondages ; le dernier se répète. */
  delaysMs?: number[];
  /** Au-delà, le sondage s'arrête (l'étape garde un message à vérifier dans Cloudflare). */
  maxMs?: number;
};

/**
 * Sondage du certificat en arrière-plan : un domaine en attente n'est pas un échec. Quand Cloudflare
 * le dit actif, le site passe ONLINE et l'étape « Certificat HTTPS » de son opération passe à « done ».
 */
export class DomainWatcher {
  private readonly active = new Map<string, AbortController>();
  private readonly delays: number[];
  private readonly maxMs: number;

  constructor(
    private readonly services: Services,
    options: DomainWatcherOptions = {},
  ) {
    this.delays = options.delaysMs?.length ? options.delaysMs : [5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000];
    this.maxMs = options.maxMs ?? 24 * 3_600_000;
  }

  watch(siteId: string): void {
    if (this.active.has(siteId)) return;
    const controller = new AbortController();
    this.active.set(siteId, controller);
    void this.loop(siteId, controller.signal)
      .catch((err) => console.error("[certificat] sondage interrompu", err instanceof Error ? err.message : err))
      .finally(() => {
        if (this.active.get(siteId) === controller) this.active.delete(siteId);
      });
  }

  unwatch(siteId: string): void {
    this.active.get(siteId)?.abort();
    this.active.delete(siteId);
  }

  isWatching(siteId: string): boolean {
    return this.active.has(siteId);
  }

  close(): void {
    for (const c of this.active.values()) c.abort();
    this.active.clear();
  }

  /** Démarrage : reprend le sondage des sites dont le certificat était en attente. */
  async resumeAll(): Promise<void> {
    const sites = await prisma.site.findMany({ where: { domainStatus: "PENDING", state: { not: "DELETING" } }, select: { id: true } });
    for (const s of sites) this.watch(s.id);
  }

  private async setWaitingDetail(siteId: string, status: OperationStep["status"], detail?: string): Promise<void> {
    const op = await findWaitingCertificateOp(siteId);
    if (!op) return;
    const steps = parseSteps(op.steps);
    const step = steps.find((s) => s.key === "certificate" && s.status === "waiting")!;
    step.status = status;
    if (detail) step.detail = detail;
    else delete step.detail;
    // Échec du certificat : opération FAILED, reprenable (« Reprendre » relance l'étape certificate).
    const failed = status === "failed" ? { status: "FAILED" as const, error: `${step.label} : ${detail ?? "échec"}`, finishedAt: new Date() } : {};
    await prisma.operation.update({ where: { id: op.id }, data: { steps: JSON.stringify(steps), ...failed } });
  }

  private async loop(siteId: string, signal: AbortSignal): Promise<void> {
    const started = Date.now();
    for (let i = 0; !signal.aborted; i++) {
      await abortableSleep(this.delays[Math.min(i, this.delays.length - 1)]!, signal);
      if (signal.aborted) return;
      const site = await prisma.site.findUnique({ where: { id: siteId } });
      if (!site || site.domainStatus !== "PENDING" || site.state === "DELETING") return;
      let domain: CfDomain | null;
      try {
        domain = await this.services.cloudflare.getDomain(pagesProjectOf(site), hostnameOf(site.slug, this.services.sitesDomain));
      } catch {
        continue;
      }
      if (signal.aborted) return;
      if (!domain) return;
      if (domain.status === "active") {
        // Étape close AVANT le passage en ligne : un site lu « en ligne » a toujours son étape certificat finie.
        await this.setWaitingDetail(siteId, "done");
        await prisma.site.update({
          where: { id: siteId },
          data: { domainStatus: "ACTIVE", ...(site.dnsRecordId && site.state !== "ONLINE" ? { state: "ONLINE", touchedAt: new Date() } : {}) },
        });
        void this.services.monitor.requestSync();
        await audit({ action: "site.certificate", result: "ok", siteId, siteSlug: site.slug });
        return;
      }
      if (isDomainError(domain.status)) {
        await prisma.site.update({ where: { id: siteId }, data: { domainStatus: "ERROR" } });
        await this.setWaitingDetail(siteId, "failed", "Cloudflare signale une erreur de validation de l'adresse : vérifier dans Cloudflare, puis reprendre ou couper le site.");
        await audit({ action: "site.certificate", result: "error", siteId, siteSlug: site.slug, detail: domain.status });
        return;
      }
      if (Date.now() - started > this.maxMs) {
        await this.setWaitingDetail(siteId, "failed", "certificat toujours en attente après 24 h : vérifier l'adresse dans Cloudflare, puis reprendre.");
        return;
      }
    }
  }
}
