export type CfProject = {
  name: string;
  /** Adresse <projet>.pages.dev renvoyée par Cloudflare (peut porter un suffixe si le nom est pris). */
  subdomain: string;
  /**
   * deployment_configs.{production,preview}.fail_open, renvoyés par getProject (null : champ absent de la
   * réponse). Le hub veut false partout (« fail closed »).
   */
  failOpen?: { production: boolean | null; preview: boolean | null };
};

/** Le projet est-il en « fail closed » (production et aperçus) ? */
export const isFailClosed = (p: Pick<CfProject, "failOpen">) => p.failOpen?.production === false && p.failOpen?.preview === false;

/** Statuts d'un domaine personnalisé Pages (champ « status » de l'API). */
export type CfDomainStatus = "initializing" | "pending" | "active" | "deactivated" | "blocked" | "error";

export type CfDomain = { name: string; status: CfDomainStatus };

export type CfDnsRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  comment: string | null;
};

export type DeployFile = {
  /** Chemin relatif, sans « / » initial. */
  path: string;
  sha256: string;
  size: number;
  read(): Promise<Buffer>;
};

export type DeployInput = {
  files: DeployFile[];
  workerJs: string;
  headersFile?: string;
  redirectsFile?: string;
};

export type CfDeployment = { id: string; url: string };

/** Déploiement listé par Cloudflare (created_on en ISO 8601). */
export type CfDeploymentInfo = { id: string; url: string; createdOn: string };

/** Préfixe du champ « comment » des CNAME créés par le hub (contrôle des orphelins). */
export const HUB_DNS_COMMENT_PREFIX = "kouzia-hub:";

/**
 * Accès à Cloudflare (Pages et DNS de la zone des sous-domaines). Les créations sont idempotentes
 * (l'existant est renvoyé), les suppressions aussi (absent = déjà fait) : une étape rejouée ne casse rien.
 */
export interface CloudflareGateway {
  readonly mode: "real" | "fake";
  createProject(name: string): Promise<CfProject>;
  /** Projet avec son réglage fail_open (deployment_configs), null s'il n'existe pas. */
  getProject(name: string): Promise<CfProject | null>;
  /** Pose deployment_configs.{production,preview}.fail_open à false (PATCH du projet). */
  setFailClosed(name: string): Promise<void>;
  listProjects(): Promise<CfProject[]>;
  deleteProject(name: string): Promise<void>;
  addDomain(project: string, hostname: string): Promise<CfDomain>;
  getDomain(project: string, hostname: string): Promise<CfDomain | null>;
  removeDomain(project: string, hostname: string): Promise<void>;
  /** Premier enregistrement de la zone portant ce nom, tout type confondu. */
  findDnsRecord(hostname: string): Promise<CfDnsRecord | null>;
  /** CNAME proxifié. */
  createCname(hostname: string, target: string, comment: string): Promise<CfDnsRecord>;
  /** Recale un CNAME du hub (cible, proxy, commentaire). */
  updateCname(id: string, hostname: string, target: string, comment: string): Promise<CfDnsRecord>;
  deleteDnsRecord(id: string): Promise<void>;
  /** Enregistrements dont le commentaire commence par « kouzia-hub: ». */
  listHubDnsRecords(): Promise<CfDnsRecord[]>;
  deploy(project: string, input: DeployInput): Promise<CfDeployment>;
  /** Déploiements du projet, du plus récent au plus ancien (premières pages seulement). */
  listDeployments(project: string): Promise<CfDeploymentInfo[]>;
  deleteDeployment(project: string, id: string): Promise<void>;
}

/** Erreur Cloudflare traduite : message français affichable, jamais de secret. */
export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly cfCode: number | null = null,
  ) {
    super(message);
  }
}
