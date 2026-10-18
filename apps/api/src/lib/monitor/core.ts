// Noyau de la surveillance partagé entre le hub (Node) et le Worker « kouzia-veille » (Cloudflare) :
// types du protocole, règle de décision des pannes, signature des requêtes. Aucun import Node ni
// Cloudflare : seulement le standard (WebCrypto global, TextEncoder), pour être regroupé dans le Worker.
// Cadrage : docs/cadrage.md, section 10.

export type Observer = "hub" | "edge";

/** Une observation HTTP d'une cible par un point de contrôle. */
export type HttpObservation = {
  targetId: string;
  observer: Observer;
  /** Horodatage en millisecondes. */
  at: number;
  ok: boolean;
  /** Statut HTTP final, null si la connexion a échoué. */
  status: number | null;
  /** Temps de réponse en ms, null si échec avant réponse. */
  ms: number | null;
  /** Raison courte affichable (« délai dépassé », « statut 503 », « mot-clé absent »), sans secret. */
  reason: string | null;
};

/** État d'une cible vu par un point de contrôle : nombre d'échecs consécutifs et dernière observation. */
export type ObserverState = {
  consecutiveFailures: number;
  last: HttpObservation | null;
};

/** Cible telle que le hub la transmet au Worker (aucune donnée de client de l'ERP). */
export type MonitorTargetSpec = {
  id: string;
  /** Libellé affiché dans la notification (nom du site ou domaine). */
  label: string;
  url: string;
  /** Mot-clé attendu dans le HTML, facultatif. */
  keyword: string | null;
};

/** Abonnement Web Push d'un appareil (forme de PushSubscription.toJSON()). */
export type PushSubscriptionSpec = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

// --- Règle de décision (tableau 10.1 du cadrage) ---

/** Échecs consécutifs avant de déclarer un échec côté d'un point de contrôle. */
export const FAILURES_BEFORE_ALERT = 2;
/** Un point de contrôle muet depuis plus longtemps est considéré hors ligne. */
export const OBSERVER_STALE_MS = 15 * 60_000;
/** Plus de cibles en panne dans le même cycle : une seule notification groupée. */
export const GROUP_ALERT_THRESHOLD = 3;
/** Fenêtre glissante du regroupement : un cycle complet (chaque cible vue une fois). */
export const GROUP_WINDOW_MS = 5 * 60_000;
/** Rappel d'un incident toujours ouvert. */
export const INCIDENT_REMINDER_MS = 24 * 3_600_000;

export type Verdict =
  /** Les deux points voient la cible répondre (ou un seul échec isolé). */
  | "up"
  /** Les deux points voient 2 échecs consécutifs : panne réelle, notification. */
  | "down"
  /** Échec vu par le hub seulement : problème local (box, DNS du FAI), sans notification. */
  | "local_only"
  /** Échec vu par le Worker seulement : sans notification. */
  | "edge_only"
  /** Pas assez d'observations récentes pour conclure. */
  | "unknown";

export type DecisionInput = {
  hub: ObserverState | null;
  edge: ObserverState | null;
  /** Dernier signe de vie de chaque point de contrôle (ms), null si jamais vu. */
  hubSeenAt: number | null;
  edgeSeenAt: number | null;
  now: number;
};

export type Decision = {
  verdict: Verdict;
  /** Points de contrôle pris en compte (un seul si l'autre est muet). */
  basis: Observer[];
};

const failing = (s: ObserverState | null) => !!s && s.consecutiveFailures >= FAILURES_BEFORE_ALERT;
const healthy = (s: ObserverState | null) => !!s && s.consecutiveFailures === 0 && !!s.last;

/**
 * Panne seulement si les deux points voient 2 échecs consécutifs. Un point muet depuis plus de
 * OBSERVER_STALE_MS est écarté : l'autre décide seul (le verdict le dit par `basis`).
 */
export function decide(input: DecisionInput): Decision {
  const hubAlive = input.hubSeenAt !== null && input.now - input.hubSeenAt <= OBSERVER_STALE_MS;
  const edgeAlive = input.edgeSeenAt !== null && input.now - input.edgeSeenAt <= OBSERVER_STALE_MS;
  const hub = hubAlive ? input.hub : null;
  const edge = edgeAlive ? input.edge : null;

  if (hub && edge) {
    if (failing(hub) && failing(edge)) return { verdict: "down", basis: ["hub", "edge"] };
    if (failing(hub) && !failing(edge)) return { verdict: healthy(edge) ? "local_only" : "unknown", basis: ["hub", "edge"] };
    if (failing(edge) && !failing(hub)) return { verdict: healthy(hub) ? "edge_only" : "unknown", basis: ["hub", "edge"] };
    return { verdict: hub.last || edge.last ? "up" : "unknown", basis: ["hub", "edge"] };
  }
  const alone = hub ?? edge;
  const who: Observer[] = hub ? ["hub"] : edge ? ["edge"] : [];
  if (!alone) return { verdict: "unknown", basis: [] };
  if (failing(alone)) return { verdict: "down", basis: who };
  return { verdict: alone.last ? "up" : "unknown", basis: who };
}

/** Nouvel état d'un point de contrôle après une observation. */
export function nextObserverState(prev: ObserverState | null, obs: HttpObservation): ObserverState {
  return {
    consecutiveFailures: obs.ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1,
    last: obs,
  };
}

// --- Protocole hub <-> Worker (HTTPS, *.workers.dev) ---

export const PROTOCOL_VERSION = 1;

/** POST /sync : configuration complète, remplace celle du Worker. */
export type SyncBody = {
  v: typeof PROTOCOL_VERSION;
  targets: MonitorTargetSpec[];
  subscriptions: PushSubscriptionSpec[];
};

/** POST /report : observations du hub depuis le dernier envoi, plus son battement de cœur. */
export type ReportBody = {
  v: typeof PROTOCOL_VERSION;
  /** Battement de cœur (ms) : « hub en vie ». */
  at: number;
  observations: HttpObservation[];
};

/** Observation du Worker avec son nombre d'échecs consécutifs (le hub ne le recalcule pas). */
export type EdgeObservation = HttpObservation & { failures?: number };

/** GET /state?since=<ms> : observations du Worker et incidents qu'il a notifiés. */
export type StateResponse = {
  v: typeof PROTOCOL_VERSION;
  now: number;
  /** Dernier passage de la tâche planifiée (ms). */
  edgeSeenAt: number | null;
  hubSeenAt: number | null;
  /** Changements d'état depuis `since`. */
  observations: EdgeObservation[];
  /**
   * État courant de chaque cible côté Worker (une ligne par cible), quel que soit `since` : une cible
   * stable n'a aucun changement récent. Absent d'un Worker plus ancien.
   */
  current?: EdgeObservation[];
  incidents: Array<{
    targetId: string;
    startedAt: number;
    endedAt: number | null;
    basis: Observer[];
  }>;
};

// --- Signature (HMAC-SHA256 horodaté, même principe que le lien ERP, section 3.4) ---

export const SIGNATURE_HEADER = "x-kouzia-veille-signature";
export const TIMESTAMP_HEADER = "x-kouzia-veille-timestamp";
/** Fenêtre d'acceptation de l'horodatage. */
export const SIGNATURE_MAX_SKEW_S = 300;

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/**
 * Message signé : « horodatage.MÉTHODE.chemin?requête.sha256(corps) ». `target` est le chemin suivi de
 * la chaîne de requête telle qu'envoyée (URL.search : vide ou commençant par « ? ») ; un paramètre
 * modifié invalide la signature. Sans requête, le message est celui de la première version.
 * Le corps vide a l'empreinte de "".
 */
async function message(timestamp: string, method: string, target: string, body: string): Promise<Uint8Array<ArrayBuffer>> {
  const bodyHash = hex(await crypto.subtle.digest("SHA-256", enc.encode(body)));
  return enc.encode(`${timestamp}.${method.toUpperCase()}.${target}.${bodyHash}`);
}

export async function signRequest(secret: string, timestamp: string, method: string, target: string, body = ""): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), await message(timestamp, method, target, body));
  return `sha256=${hex(sig)}`;
}

/** Vérification en temps constant (crypto.subtle.verify), horodatage dans la fenêtre. */
export async function verifyRequest(
  secret: string,
  headers: { timestamp: string | null; signature: string | null },
  method: string,
  target: string,
  body: string,
  nowMs: number,
): Promise<boolean> {
  const { timestamp, signature } = headers;
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp) || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SIGNATURE_MAX_SKEW_S) return false;
  const raw = Uint8Array.from(signature.slice(7).match(/../g)!, (h) => parseInt(h, 16));
  return crypto.subtle.verify("HMAC", await hmacKey(secret), raw, await message(timestamp, method, target, body));
}

// --- Services push acceptés (abonnement côté hub, /sync côté Worker) ---

const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
];

/**
 * Adresse d'un service push connu (Google, Mozilla, Apple, Microsoft), en https sur le port par défaut :
 * ni le hub ni le Worker n'envoient de requête vers une adresse choisie par un tiers.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.username || u.password) return false;
  return PUSH_HOSTS.some((re) => re.test(u.hostname));
}
