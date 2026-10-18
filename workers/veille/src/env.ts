// Types de l'environnement du Worker. Sous-ensemble des API Cloudflare réellement utilisées, écrit ici
// pour ne pas ajouter de dépendance de types (le regroupement n'en a pas besoin).

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface Env {
  DB: D1Database;
  MONITOR_SHARED_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Dépendances injectables (horloge, réseau) : les tests remplacent les deux. */
export type Deps = {
  now: () => number;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
};

export const realDeps = (): Deps => ({
  now: () => Date.now(),
  fetch: (input, init) => fetch(input, init),
});

// --- Réglages (cadrage 10.3 : 10 ms de CPU, 50 sous-requêtes, 6 connexions par invocation) ---

/** Cinq tranches : chaque cible est contrôlée une minute sur cinq. */
export const SLOTS = 5;
export const CHECK_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 5;
/** Sous-requêtes des contrôles (redirections comprises) par passage. */
export const MAX_CHECK_SUBREQUESTS = 40;
export const MAX_CONCURRENCY = 6;
/** Plafond de l'offre gratuite, toutes sous-requêtes confondues. */
export const SUBREQUEST_LIMIT = 50;
/**
 * Envois push par passage. Mesure Node (test push-cpu) : environ 1 ms de CPU par envoi, 1,3 ms pour la
 * pire série ; 4 envois (5 ms au pire) laissent la moitié des 10 ms aux contrôles. Le reste attend dans
 * push_queue et part au passage suivant (une minute plus tard).
 */
export const PUSH_PER_PASS = 4;
/** Une notification non partie après ce délai n'a plus de sens. */
export const PUSH_QUEUE_TTL_MS = 24 * 3_600_000;
export const PUSH_MAX_ATTEMPTS = 5;
/** Lecture du HTML pour le mot-clé : au-delà, le mot-clé est cherché dans le début seulement. */
export const KEYWORD_SCAN_BYTES = 256 * 1024;
/** Corps accepté sur /sync et /report. */
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_TARGETS = 500;
export const MAX_SUBSCRIPTIONS = 20;
export const MAX_OBSERVATIONS = 5_000;
