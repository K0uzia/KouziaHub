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
  /** Contrat de maintenance (facultatif, ignoré tant que la route de l'ERP ne le fournit pas). */
  maintenance?: { active: boolean; startsAt: string | null; endsAt: string | null };
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
  /**
   * Le .htaccess que le hub générerait aujourd'hui (profil et fichiers actuels) diffère du dernier écrit :
   * généré, il sera mis à jour à la prochaine publication ; modifié à la main, « régénérer ? ».
   */
  outdated: boolean;
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
  /** Fichiers de développement servis quand même (onglet Serveur). */
  devFilesAllowed: string[];
  /** CSP du site (version de travail et .htaccess de l'export), null : CSP par défaut. */
  siteCsp: string | null;
  /** Indexation autorisée : plus de noindex, robots.txt qui autorise (appliqué au prochain déploiement). */
  allowIndexing: boolean;
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
  /** fail_open : réglage « fail closed » d'un projet Pages non recalé par le contrôle quotidien. */
  code: "cloudflare_fake" | "erp_unavailable" | "erp_fake" | "orphans" | "projects_near_limit" | "fail_open";
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
  /** Exceptions aux fichiers de développement refusés (chemins exacts ou dossiers terminés par « / »). */
  devFilesAllowed?: string[];
  /** CSP du site, null ou vide : CSP par défaut. */
  siteCsp?: string | null;
  /** Autoriser l'indexation par les moteurs (cinquième série, 22/10/2026), appliquée à la prochaine publication. */
  allowIndexing?: boolean;
};

export type WorkingFileEntry = { path: string; size: number; updatedAt: string; sha256: string };

/**
 * Contrôle de la version de travail avant publication (lib/version-check.ts) : projet non construit, site
 * construit envoyé avec ses sources, ou index.html absent de la racine. Publication refusée sans « force ».
 */
export type VersionCheck = {
  code: "unbuilt" | "output_folder" | "no_index";
  /** Framework reconnu (« Astro », « Next.js »...), null s'il est inconnu. */
  framework: string | null;
  /** Commande à lancer sur le PC (unbuilt). */
  command: string | null;
  /** Dossier à envoyer (« dist/ »). */
  outDir: string | null;
  /** Script build de package.json, tel qu'écrit (« astro build »). */
  buildScript: string | null;
  message: string;
};

export type FilesResponse = {
  files: WorkingFileEntry[];
  totalBytes: number;
  /** Présence de index.html à la racine. */
  hasIndex: boolean;
  /** Contrôle de la version, null si elle est publiable telle quelle. */
  versionCheck: VersionCheck | null;
  /** Fichiers de développement restés dans la version de travail (ancien envoi) : à nettoyer. */
  devFiles: string[];
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
  /** Mode « replace » : fichiers de travail retirés (absents du nouvel envoi). */
  removed?: number;
  /** Projet reconnu sur tout l'envoi, fichiers écartés compris (package.json, astro.config...), s'il n'est pas construit. */
  projectCheck?: VersionCheck | null;
  files: FilesResponse;
};

/** Fichier annoncé à l'ouverture d'une session d'envoi : chemin relatif au dossier cible, taille, empreinte SHA-256 (hex). */
export type UploadFileDecl = { path: string; size: number; sha256: string };

/**
 * Session d'envoi par morceaux (gros dossiers et zips, au-delà des 100 Mo par requête du tunnel) : les fichiers
 * retenus, mis bout à bout dans l'ordre de `included`, ou le zip, forment un flux découpé en morceaux de `chunkSize`.
 */
export type CreateUploadInput =
  /** mode « replace » (racine seulement) : la version de travail est vidée puis remplie par l'envoi, en une opération. */
  | { kind: "files"; dir?: string; files: UploadFileDecl[]; mode?: "replace" | "merge" }
  | { kind: "zip"; mode: "replace" | "merge"; name: string; size: number; sha256: string };

export type UploadSession = {
  id: string;
  kind: "files" | "zip";
  /** Envoi de fichiers : dossier cible ; mode (fichiers et zip). */
  dir: string | null;
  mode: "replace" | "merge" | null;
  /** Fichiers retenus (chemins complets dans le site) ; zip : son nom. Sert à vérifier une sélection refaite avant de reprendre. */
  files: UploadFileDecl[];
  /** Index, dans la liste envoyée à la création, des fichiers retenus, dans l'ordre du flux. */
  included: number[];
  /** Écartés dès l'ouverture (chemin interdit, dossier de développement, fichier de plus de 25 Mio), avec la raison. */
  rejected: RejectedFile[];
  chunkSize: number;
  totalBytes: number;
  chunkCount: number;
  /** Morceaux déjà reçus et vérifiés (numéros à partir de 0). */
  received: number[];
  createdAt: string;
  expiresAt: string;
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

/**
 * Liste longue paginée côté serveur (journal, versions, incidents) : page à partir de 1, pageSize 20 par
 * défaut, 100 au plus (plafonné). Tri du plus récent au plus ancien. Page au-delà de la dernière : items vide.
 */
export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };

/** Filtres du journal (dans l'URL de l'écran, validés par le serveur) ; dates AAAA-MM-JJ incluses. */
export type AuditFilters = { action?: string; result?: "ok" | "error"; from?: string; to?: string };

/** Filtres des incidents : en cours ou terminés, période sur le début de l'incident. */
export type IncidentFilters = { state?: "open" | "closed"; from?: string; to?: string };

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
  /** Capture automatique des vignettes ; indisponible avec la raison (repli : image envoyée). */
  thumbnails: { capture: boolean; reason: string | null };
  /** Mesure de vitesse de la surveillance : indisponible avec la raison (bac à sable, utilisateur dédié). */
  speed: { available: boolean; reason: string | null };
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
// POST   /api/sites/:id/files/delete   { paths: string[] } (un dossier se termine par « / ») : FilesResponse
// POST   /api/sites/:id/files/move     { from: string, to: string } (renommer) : FilesResponse
//
// Envoi de fichiers et de zips : uniquement par sessions, en morceaux (seul chemin d'entrée des fichiers) :
// GET    /api/sites/:id/uploads                  : UploadSession[] (sessions ouvertes du site, pour reprendre)
// POST   /api/sites/:id/uploads   CreateUploadInput : UploadSession (400 sans rien d'envoyable)
// GET    /api/sites/:id/uploads/:uid             : UploadSession (404 code "upload_expired" après 24 h)
// PUT    /api/sites/:id/uploads/:uid/chunks/:n   octets (application/octet-stream), en-tête X-Chunk-Sha256 : UploadSession
//                                ; morceau déjà reçu avec la même empreinte : accepté sans effet ; empreinte fausse : 400 "chunk_hash_mismatch"
// POST   /api/sites/:id/uploads/:uid/complete    : UploadResult (vérifie chaque empreinte puis les contrôles habituels, tout ou rien ;
//                                409 "upload_incomplete" s'il manque des morceaux ; la session est supprimée après succès)
// DELETE /api/sites/:id/uploads/:uid             : { ok: true } (annulation)
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
// GET    /api/audit?page=&pageSize=&siteId=&action=&result=&from=&to= : Page<AuditEntry>

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
  /** Plus petit nombre de jours restants (certificat ou domaine) sur les cibles surveillées, null si inconnu. */
  expiresInDays: number | null;
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
    speed: { available: boolean; reason: string | null };
  };
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
  reports: Array<{ id: string; month: string; createdAt: string }>;
};

export type CloudflareZoneSuggestion = { name: string; alreadyWatched: boolean };

/** endpoint : pour reconnaître « cet appareil » (renvoyé seulement à l'utilisateur connecté). */
export type PushDevice = { id: string; label: string; endpoint: string; createdAt: string; lastSuccessAt: string | null; lastError: string | null };

// Routes de la surveillance
//
// GET    /api/monitor                              : MonitorOverview
// POST   /api/monitor/targets   CreateMonitorTargetInput : MonitorTargetEntry (domaine ajouté à la main)
// GET    /api/monitor/targets/:id?days=30          : MonitorTargetDetail (incidents : route paginée ci-dessous)
// GET    /api/monitor/incidents?page=&pageSize=&targetId=&siteId=&state=&from=&to= : Page<MonitorIncidentEntry>
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

// --- Purges, cache et export de production ---

/** Nombre d'éléments supprimés et place libérée. */
export type PurgeCount = { count: number; bytes: number };

/** POST /api/sites/:id/files/purge : vider la version de travail (et, au choix, les anciennes versions). */
export type SiteFilesPurgeInput = { confirm: string; versions?: boolean };
export type SiteFilesPurgeResult = {
  removedFiles: number;
  /** null si l'option « anciennes versions » n'était pas demandée. */
  versions: {
    /** Numéros des versions passées en PURGED (déploiement Cloudflare supprimé). */
    purged: number[];
    /** Numéros gardés : la version servie, et celles dont la suppression chez Cloudflare a échoué. */
    kept: number[];
    failed: Array<{ number: number; error: string }>;
  } | null;
  freedBytes: number;
  files: FilesResponse;
};

export type StorageUsage = {
  /** Par site : contenus de la version de travail, versions gardées (chaque contenu compté une fois et hors
   *  version de travail), vignette, envois en cours. Un contenu partagé entre sites compte dans chacun. */
  sites: Array<{ siteId: string; slug: string; workingBytes: number; versionsBytes: number; thumbnailBytes: number; uploadsBytes: number; totalBytes: number }>;
  /** Disque réellement occupé : magasin d'objets (dédoublonné), vignettes, envois en cours, temporaires. */
  total: { blobsBytes: number; orphanBytes: number; thumbnailsBytes: number; uploadsBytes: number; tempBytes: number; totalBytes: number };
};

/**
 * Purge du cache du hub. uploads : sessions d'envoi, même en cours (d'un site si siteId, sinon toutes) ;
 * temp et orphans : globaux, ignorés avec siteId ; thumbnails : vignettes capturées seulement (régénérables).
 */
export type HubCachePurgeInput = {
  siteId?: string | null;
  uploads?: boolean;
  temp?: boolean;
  thumbnails?: boolean;
  orphans?: boolean;
  /** Obligatoire (true) avec uploads ou thumbnails : suppressions visibles (envoi à relancer, vignette à recapturer). */
  confirm?: boolean;
};
export type HubCachePurgeResult = {
  freedBytes: number;
  uploads: PurgeCount | null;
  /** Sessions d'envoi occupées (morceau en écriture, assemblage, import) : gardées. */
  uploadsSkipped: number;
  temp: PurgeCount | null;
  thumbnails: PurgeCount | null;
  orphans: PurgeCount | null;
};

/** Purge du cache Cloudflare d'un site : par nom d'hôte, repli par adresses en lots de 100. */
export type CachePurgeResult = {
  method: "hosts" | "files";
  hosts: string[];
  /** Domaine final hors de la zone du hub : non purgé (autre zone, autre jeton). */
  skippedHosts: string[];
  urlsPurged: number;
  urlsTotal: number;
  /** Faux si la limite de Cloudflare (5 purges par minute) a interrompu la purge par adresses. */
  complete: boolean;
  message: string;
};

export type ExportTarget = "hostinger" | "pages";

export type ExportIssue = {
  level: "info" | "warning" | "error";
  code:
    | "no_final_domain"
    | "no_404"
    | "robots_blocking"
    | "robots_sitemap_domain"
    | "robots_generated"
    | "sitemap_generated"
    | "sitemap_domain"
    | "sitemap_child_missing"
    | "noindex_meta"
    | "x_robots_meta"
    | "canonical_missing"
    | "canonical_domain"
    | "title_missing"
    | "description_missing"
    | "html_too_large"
    | "dev_files_removed"
    | "pages_files_removed"
    | "htaccess_modified";
  message: string;
  /** Fichiers ou adresses concernés (20 au plus) ; total donne leur nombre réel. */
  paths: string[];
  total: number;
};

export type ExportSummary = {
  versionId: string;
  versionNumber: number;
  target: ExportTarget;
  /** Nom du zip : <slug>-v<N>-production.zip (suffixe -pages pour Cloudflare Pages). */
  fileName: string;
  fileCount: number;
  totalBytes: number;
  finalDomain: string | null;
  /** https://<forme canonique du domaine final>, null sans domaine final. */
  canonicalOrigin: string | null;
  /** Fichiers produits par le hub (.htaccess, robots.txt, sitemap.xml, 404, LISEZMOI.txt, _headers...). */
  generated: string[];
  /** Fichiers de la version retirés, avec la raison. */
  removed: RejectedFile[];
  issues: ExportIssue[];
};

// Routes des purges et de l'export
//
// POST   /api/sites/:id/files/purge     SiteFilesPurgeInput : SiteFilesPurgeResult (confirm = slug exact, sinon 400)
// POST   /api/sites/:id/cache/purge                          : CachePurgeResult (cache Cloudflare du sous-domaine)
//                                ; 403 code "cf_permission" (jeton sans Cache Purge), 409 code "cf_rate_limited"
// GET    /api/storage                                        : StorageUsage
// POST   /api/storage/purge             HubCachePurgeInput    : HubCachePurgeResult (400 code "confirm_required"
//                                                              si uploads ou thumbnails sans confirm: true)
// GET    /api/sites/:id/export/summary?version=&target=      : ExportSummary (version : défaut la version servie ;
//                                                              target : hostinger par défaut, ou pages)
// GET    /api/sites/:id/export?version=&target=              : zip en pièce jointe (Content-Disposition attachment)

// --- Réglages des rapports (pied de page du rapport mensuel) ---

/** Coordonnées imprimées en pied de page des rapports ; null = non renseigné, rien d'affiché. */
export type ReportSettings = {
  displayName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
};
/** Champ vide ou null : effacé. Erreur 400 code "invalid_field" avec `field` (nom du champ en cause). */
export type UpdateReportSettingsInput = Partial<Record<keyof ReportSettings, string | null>>;

// GET    /api/settings/reports                   : ReportSettings
// PATCH  /api/settings/reports  UpdateReportSettingsInput : ReportSettings

/**
 * Contrôle d'un champ des réglages « Rapports », partagé par l'API (dans son schéma zod) et le formulaire.
 * Vide : null (la valeur est effacée). Téléphone français enregistré sur 10 chiffres (« 0612345678 »),
 * site web en https:// seulement.
 */
export function checkReportField(field: keyof ReportSettings, raw: string | null | undefined): { ok: true; value: string | null } | { ok: false; error: string } {
  const value = (raw ?? "").trim();
  if (!value) return { ok: true, value: null };
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, error: "Caractères de contrôle interdits." };
  if (field === "displayName") {
    return value.length > 80 ? { ok: false, error: "80 caractères au plus." } : { ok: true, value };
  }
  if (field === "email") {
    return value.length <= 120 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[a-z]{2,}$/i.test(value)
      ? { ok: true, value: value.toLowerCase() }
      : { ok: false, error: "Adresse e-mail invalide (exemple : nom@domaine.fr)." };
  }
  if (field === "phone") {
    const compact = value.replace(/[\s.-]/g, "");
    const m = /^(?:0([1-9]\d{8})|\+33([1-9]\d{8}))$/.exec(compact);
    return m ? { ok: true, value: `0${m[1] ?? m[2]}` } : { ok: false, error: "Numéro français attendu : 10 chiffres commençant par 0, ou +33 suivi de 9 chiffres." };
  }
  if (!/^https:\/\//i.test(value)) return { ok: false, error: "L'adresse doit commencer par https://." };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "Adresse de site invalide (exemple : https://www.domaine.fr)." };
  }
  if (value.length > 200 || url.username || url.password || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(url.hostname)) {
    return { ok: false, error: "Adresse de site invalide (exemple : https://www.domaine.fr)." };
  }
  return { ok: true, value: `https://${url.hostname.toLowerCase()}${url.pathname === "/" ? "" : url.pathname}${url.search}` };
}

// --- Logiciels : licences Tracebay (docs/licences-logiciels.md, section 6) ---
// GET   /api/logiciels                         : SoftwareCatalog
// GET   /api/logiciels/:slug                   : SoftwareDetail (liste des clés, sans la chaîne TB1)
// POST  /api/logiciels/:slug/cles              : LicenseDetail, 201 (503 sans clé de signature ; 503 erp_unavailable)
// GET   /api/logiciels/:slug/cles/:id          : LicenseDetail (clé et contact déchiffrés)
// PATCH /api/logiciels/:slug/cles/:id          : LicenseDetail (notes, contact, client ERP seulement)
// Pas de DELETE, pas de révocation : la vérification se fait hors ligne, l'expiration tient lieu de fin de droit.

/** Calculé au jour de Paris : expirée le lendemain de « expire », bientôt expirée à 30 jours ou moins (jour inclus). */
export type LicenseStatus = "active" | "expiring" | "expired";

export type SoftwareSummary = {
  slug: string;
  name: string;
  format: string;
  counts: { active: number; expiring: number; expired: number };
};

export type SoftwareCatalog = { software: SoftwareSummary[] };

export type LicenseSummary = {
  id: string;
  entreprise: string;
  erpClientId: string | null;
  /** Nom lu dans l'ERP, null si non rattaché ou ERP indisponible. */
  clientName: string | null;
  /** AAAA-MM-JJ, heure de Paris. */
  emise: string;
  expire: string;
  status: LicenseStatus;
  notes: string | null;
  createdAt: string;
};

export type SoftwareDetail = {
  software: SoftwareSummary;
  /** Clé de signature présente et lisible sur le serveur : émission possible. */
  signing: boolean;
  /** Jour de Paris du serveur (date d'émission d'une nouvelle clé). */
  today: string;
  licenses: LicenseSummary[];
};

export type LicenseDetail = LicenseSummary & {
  /** Chaîne TB1 complète, en clair seulement dans ce détail. */
  cle: string;
  contact: string | null;
};

export type CreateLicenseInput = {
  entreprise: string;
  erpClientId?: string | null;
  contact?: string | null;
  notes?: string | null;
  /** Un des deux, pas les deux. */
  months?: number;
  expire?: string;
};

export type UpdateLicenseInput = {
  notes?: string | null;
  contact?: string | null;
  erpClientId?: string | null;
};
