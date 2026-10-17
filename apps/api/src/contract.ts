// Contrat de l'API du hub, partagé avec l'interface (alias @hub/contract). Types seuls, aucun code :
// l'interface l'importe sans embarquer de dépendance serveur. Dates en chaînes ISO.
// Toute route sauf /api/health et /api/auth/login|2fa|me exige la session (401 sinon).
// Erreur : statut HTTP >= 400 et corps { error: string, code?: string }.

export type SiteKind = "CLIENT" | "PERSO";
export type SiteState = "CREATING" | "ONLINE" | "OFFLINE" | "DELETING";
export type DomainStatus = "NONE" | "PENDING" | "ACTIVE" | "ERROR";
export type OperationKind = "CREATE" | "ENABLE" | "DISABLE" | "DELETE" | "PUBLISH";
export type OperationStatus = "RUNNING" | "FAILED" | "DONE";
export type StepStatus = "todo" | "running" | "done" | "failed" | "waiting";
export type VersionStatus = "UPLOADING" | "PUBLISHED" | "FAILED" | "PURGED";

export type OperationStep = {
  key: string;
  /** Libellé affiché (« Projet Cloudflare créé »). */
  label: string;
  status: StepStatus;
  /** Précision affichable (« certificat en cours, quelques minutes »), jamais un secret. */
  detail?: string;
};

export type Operation = {
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  steps: OperationStep[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

/** Client lu dans l'ERP (lecture seule, champs minimaux). */
export type ErpClient = {
  id: string;
  clientNumber: string | null;
  displayName: string;
  type: "B2B" | "B2C" | "ASSOCIATION";
};

export type SiteSummary = {
  id: string;
  slug: string;
  /** <slug>.kouzia.com */
  hostname: string;
  /** https://<slug>.kouzia.com */
  url: string;
  kind: SiteKind;
  /** Nom affiché : libellé, sinon nom du client lu dans l'ERP, sinon le sous-domaine. */
  name: string;
  label: string | null;
  erpClientId: string | null;
  /** Nom du client (ERP), null si perso ou ERP indisponible. */
  clientName: string | null;
  state: SiteState;
  domainStatus: DomainStatus;
  /**
   * Opération en cours, dernière opération échouée, ou dernière création / remise en ligne dont l'étape
   * « certificate » attend encore (status DONE, étape « waiting ») ; null sinon.
   */
  operation: Operation | null;
  /** Fichiers de travail modifiés depuis la dernière publication. */
  workingDirty: boolean;
  currentVersion: { id: string; number: number; publishedAt: string | null } | null;
  /** URL de la vignette servie par le hub (/api/sites/:id/thumbnail?v=...), null sans vignette. */
  thumbnailUrl: string | null;
  touchedAt: string;
  createdAt: string;
  /** Surveillance du site (null si aucune cible surveillée). */
  monitor: SiteMonitorBadge | null;
};

export type CanonicalHost = "www" | "apex";

/**
 * .htaccess de la version de travail (hébergement final Apache ou LiteSpeed), généré depuis le profil :
 * « generated » = identique au dernier écrit par le hub ; « modified » = changé à la main ou par un zip ;
 * « missing » = absent. Hors « generated », le hub ne le réécrit qu'avec force (confirmation).
 */
export type ServerConfigState = {
  status: "generated" | "modified" | "missing";
  path: ".htaccess";
  /** Dernière écriture par le hub, null si jamais. */
  generatedAt: string | null;
  /** La page 404 du profil existe dans la version de travail. */
  notFoundPagePresent: boolean;
};

/** Aperçu de ce que le hub génère depuis le profil (rien n'est écrit). */
export type ServerConfigPreview = {
  htaccess: string;
  /** Envoyés à Cloudflare Pages au déploiement (fusionnés avec _headers et _redirects du site), null si vides. */
  pagesHeaders: string | null;
  pagesRedirects: string | null;
  /** Le site pose lui-même Cache-Control dans _headers : le hub n'ajoute alors aucune règle de cache. */
  hubCacheRules: boolean;
};

export type SiteDetail = SiteSummary & {
  pagesProject: string;
  /** Adresse <projet>.pages.dev (redirigée vers le sous-domaine). */
  pagesSubdomain: string | null;
  /** Lien vers la fiche du client dans l'ERP, null si inconnu. */
  erpClientUrl: string | null;
  thumbnailSource: "capture" | "upload" | null;
  fileCount: number;
  totalBytes: number;
  /** Profil serveur : domaine final (sans « www. »), forme canonique, page 404. */
  finalDomain: string | null;
  canonicalHost: CanonicalHost;
  notFoundPage: string;
  serverConfig: ServerConfigState;
};

export type CatalogResponse = {
  sites: SiteSummary[];
  stats: {
    online: number;
    offline: number;
    creating: number;
    errors: number;
    /** Projets Pages du compte (tous, pas seulement ceux du hub) ; null si inconnu. */
    projectsUsed: number | null;
    projectsLimit: number;
  };
  /** Avertissements affichables (ERP indisponible, Cloudflare simulé, orphelins). */
  notices: Notice[];
};

export type Notice = {
  level: "info" | "warning" | "error";
  code: "cloudflare_fake" | "erp_unavailable" | "erp_fake" | "orphans" | "projects_near_limit";
  message: string;
};

export type SlugCheck = { slug: string; ok: boolean; reason: string | null };

export type CreateSiteInput =
  | { kind: "CLIENT"; erpClientId: string; slug: string; label?: string | null }
  | { kind: "PERSO"; slug: string; label: string };

/**
 * Un changement de finalDomain, canonicalHost ou notFoundPage régénère le .htaccess s'il est encore
 * « generated » (sinon il reste tel quel, état renvoyé dans serverConfig).
 */
export type UpdateSiteInput = {
  label?: string | null;
  erpClientId?: string | null;
  finalDomain?: string | null;
  canonicalHost?: CanonicalHost;
  notFoundPage?: string;
};

export type WorkingFileEntry = { path: string; size: number; updatedAt: string; sha256: string };

export type FilesResponse = {
  files: WorkingFileEntry[];
  totalBytes: number;
  /** Présence de index.html à la racine (sinon la publication est refusée). */
  hasIndex: boolean;
  workingDirty: boolean;
  limits: { maxFiles: number; maxFileBytes: number; maxZipBytes: number };
};

/** Fichier écarté lors d'un envoi, avec la raison affichable. */
export type RejectedFile = { path: string; reason: string };

export type UploadResult = {
  accepted: string[];
  rejected: RejectedFile[];
  /** Zip seulement : dossier racine unique retiré automatiquement (ex. « dist/ »), null sinon. */
  strippedRoot?: string | null;
  files: FilesResponse;
};

export type VersionEntry = {
  id: string;
  number: number;
  note: string | null;
  source: "files" | "zip" | "placeholder" | "republish";
  sourceVersionNumber: number | null;
  fileCount: number;
  totalBytes: number;
  status: VersionStatus;
  error: string | null;
  createdAt: string;
  publishedAt: string | null;
  /** Version servie actuellement. */
  current: boolean;
};

export type AuditEntry = {
  id: string;
  siteSlug: string | null;
  action: string;
  result: "ok" | "error";
  detail: string | null;
  at: string;
};

export type OrphanFinding = {
  type: "dns" | "project" | "site";
  name: string;
  detail: string;
  /** Suppression proposée dans l'interface (enregistrement DNS orphelin seulement). */
  deletable: boolean;
};

export type OrphanReport = {
  checkedAt: string | null;
  mode: "real" | "fake";
  findings: OrphanFinding[];
  error: string | null;
};

export type SystemStatus = {
  cloudflare: { mode: "real" | "fake"; projectsUsed: number | null; projectsLimit: number };
  erp: { mode: "http" | "fake"; reachable: boolean };
  thumbnails: { capture: boolean };
  sitesDomain: string;
};

// Routes (méthode, chemin : corps, réponse)
//
// GET    /api/sites                              : CatalogResponse
// GET    /api/sites/slug-check?slug=             : SlugCheck
// GET    /api/sites/slug-check?name=             : SlugCheck du sous-domaine proposé depuis un nom (minuscules, sans accent)
// POST   /api/sites                    CreateSiteInput : SiteDetail (opération CREATE lancée)
// GET    /api/sites/:id                          : SiteDetail
// PATCH  /api/sites/:id                UpdateSiteInput : SiteDetail
// POST   /api/sites/:id/enable                   : SiteDetail (opération ENABLE)
// POST   /api/sites/:id/disable                  : SiteDetail (opération DISABLE)
// POST   /api/sites/:id/operations/:opId/retry   : SiteDetail (reprend à l'étape en échec)
// DELETE /api/sites/:id                { confirm: slug } : SiteDetail (opération DELETE) ; 404 ensuite
//
// GET    /api/sites/:id/files                    : FilesResponse
// GET    /api/sites/:id/files/raw?path=          : contenu du fichier (téléchargement, Content-Disposition attachment)
// POST   /api/sites/:id/files   multipart : champs « dir » (dossier cible, facultatif) puis fichiers ;
//                                le nom de chaque fichier peut contenir des sous-dossiers (envoi de dossier)
//                                : UploadResult (ajout ou remplacement)
// POST   /api/sites/:id/files/delete   { paths: string[] } (un dossier se termine par « / ») : FilesResponse
// POST   /api/sites/:id/files/move     { from: string, to: string } (renommer) : FilesResponse
// POST   /api/sites/:id/zip     multipart : un fichier zip, champ « mode » = "replace" | "merge" : UploadResult
//
// POST   /api/sites/:id/publish        { note?: string } : SiteDetail (opération PUBLISH)
// GET    /api/sites/:id/versions                 : VersionEntry[]
// POST   /api/sites/:id/versions/:vid/publish    : SiteDetail (republie cette version, opération PUBLISH)
// POST   /api/sites/:id/versions/:vid/restore    : FilesResponse (la version devient la version de travail)
//
// GET    /api/sites/:id/server-config/preview   : ServerConfigPreview
// POST   /api/sites/:id/server-config/regenerate  { force?: boolean } : SiteDetail
//                                ; 409 code "server_config_modified" si le .htaccess est modifié ou absent sans force
//
// GET    /api/sites/:id/thumbnail                : image WebP (privée, Cache-Control private)
// POST   /api/sites/:id/thumbnail  multipart image : SiteDetail
// POST   /api/sites/:id/thumbnail/capture        : SiteDetail (capture relancée, en arrière-plan)
//
// GET    /api/erp/clients?q=                     : { clients: ErpClient[]; available: boolean }
// GET    /api/system                             : SystemStatus
// GET    /api/orphans                            : OrphanReport
// POST   /api/orphans/check                      : OrphanReport
// POST   /api/orphans/dns/delete       { name: string } : OrphanReport
// GET    /api/audit?siteId=&limit=               : AuditEntry[]

// --- Surveillance (cadrage section 10) ---

export type MonitorVerdict = "up" | "down" | "local_only" | "edge_only" | "unknown";
export type MonitorSource = "site" | "cloudflare" | "manual";

/** Résumé de surveillance d'un site, porté par SiteSummary.monitor (null si aucune cible). */
export type SiteMonitorBadge = {
  /** Pire verdict des cibles surveillées du site ; "unknown" si aucune observation. */
  verdict: MonitorVerdict;
  /** Nombre de cibles surveillées (interrupteur actif). */
  watched: number;
  /** Disponibilité des 30 derniers jours en %, null si pas assez de données. */
  uptime30d: number | null;
  /** Incident ouvert le plus ancien (ISO), null sinon. */
  openIncidentSince: string | null;
};

export type MonitorCheckKind = "http" | "tls" | "domain" | "dns" | "content" | "speed";

export type MonitorTargetEntry = {
  id: string;
  siteId: string | null;
  /** Slug du site lié (lien vers la fiche), null si domaine seul. */
  siteSlug: string | null;
  label: string;
  url: string;
  hostname: string;
  source: MonitorSource;
  erpClientId: string | null;
  clientName: string | null;
  enabled: boolean;
  keyword: string | null;
  verdict: MonitorVerdict;
  /** Points de contrôle pris en compte par le verdict. */
  basis: Array<"hub" | "edge">;
  lastHub: { at: string; ok: boolean; status: number | null; ms: number | null; reason: string | null } | null;
  lastEdge: { at: string; ok: boolean; status: number | null; ms: number | null; reason: string | null } | null;
  uptime24h: number | null;
  uptime30d: number | null;
  /** Certificat : échéance (ISO) et jours restants, null si non contrôlé. */
  certificate: { validTo: string; daysLeft: number; issuer: string | null; ok: boolean; error: string | null } | null;
  /** Échéance du domaine par RDAP, null si inconnue. */
  domainExpiry: { expiresAt: string | null; daysLeft: number | null; registrar: string | null; checkedAt: string } | null;
  dns: { status: "ok" | "drift" | "no_reference" | "error"; checkedAt: string | null; detail: string | null } | null;
  content: { status: "ok" | "changed" | "no_reference" | "error"; checkedAt: string | null } | null;
  speed: { measuredAt: string; ttfbMs: number | null; lcpMs: number | null; cls: number | null; bytes: number | null; requests: number | null } | null;
  openIncident: { id: string; startedAt: string; basis: Array<"hub" | "edge"> } | null;
  createdAt: string;
};

export type MonitorIncidentEntry = {
  id: string;
  targetId: string;
  targetLabel: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  cause: string | null;
  basis: Array<"hub" | "edge">;
};

export type MonitorOverview = {
  targets: MonitorTargetEntry[];
  stats: { watched: number; up: number; down: number; warnings: number; openIncidents: number };
  /** État des deux points de contrôle et des notifications. */
  health: {
    edge: { configured: boolean; lastSeenAt: string | null; lastSyncAt: string | null; error: string | null };
    hubChecksRunning: boolean;
    push: { configured: boolean; devices: number };
    zonesToken: boolean;
  };
  recentIncidents: MonitorIncidentEntry[];
};

export type CreateMonitorTargetInput = {
  url: string;
  label: string;
  erpClientId?: string | null;
  keyword?: string | null;
};
export type UpdateMonitorTargetInput = { label?: string; enabled?: boolean; keyword?: string | null; erpClientId?: string | null };

export type MonitorHistoryPoint = { hour: string; observer: "hub" | "edge"; checks: number; failures: number; avgMs: number | null; p95Ms: number | null };

export type MonitorTargetDetail = MonitorTargetEntry & {
  history: MonitorHistoryPoint[];
  incidents: MonitorIncidentEntry[];
  reports: Array<{ id: string; month: string; createdAt: string }>;
};

export type CloudflareZoneSuggestion = { name: string; alreadyWatched: boolean };

export type PushDevice = { id: string; label: string; createdAt: string; lastSuccessAt: string | null; lastError: string | null };

// Routes de la surveillance
//
// GET    /api/monitor                              : MonitorOverview
// POST   /api/monitor/targets   CreateMonitorTargetInput : MonitorTargetEntry (domaine ajouté à la main)
// GET    /api/monitor/targets/:id?days=30          : MonitorTargetDetail
// PATCH  /api/monitor/targets/:id  UpdateMonitorTargetInput : MonitorTargetEntry (interrupteur « Surveillé »)
// DELETE /api/monitor/targets/:id                  : { ok: true } (cibles manuelles ou cloudflare seulement)
// POST   /api/monitor/targets/:id/check            : MonitorTargetEntry (contrôle HTTP immédiat par le hub)
// POST   /api/monitor/targets/:id/dns/accept       : MonitorTargetEntry (l'état DNS actuel devient la référence)
// POST   /api/monitor/targets/:id/content/accept   : MonitorTargetEntry (l'accueil actuel devient la référence)
// GET    /api/monitor/targets/:id/reports/:month.pdf : PDF (mois AAAA-MM ; généré à la demande s'il manque)
// GET    /api/monitor/zones                        : { available: boolean; zones: CloudflareZoneSuggestion[] }
// POST   /api/monitor/zones/:name/watch            : MonitorTargetEntry (zone proposée ajoutée en https://<zone>)
// GET    /api/sites/:id/monitor                    : MonitorTargetEntry[] (cibles du site : version de travail, domaine final)
//
// GET    /api/push/config                          : { publicKey: string | null }
// GET    /api/push/devices                         : PushDevice[]
// POST   /api/push/subscribe   { subscription: PushSubscriptionJSON, label: string } : PushDevice
// DELETE /api/push/devices/:id                     : { ok: true }
// POST   /api/push/test                            : { sent: number; failed: number }
