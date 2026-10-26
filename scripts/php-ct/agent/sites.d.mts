// Types des opérations de l'agent sur les sites (sites.mjs), pour les tests du hub.

export const SITE_UID_MIN: number;
export const SITE_UID_MAX: number;
export const RELEASES_KEPT: number;
export const SLUG_RE: RegExp;
export const MARIADB_SOCKET: string;
export const DUMPS_KEPT: number;
export const DB_VARS: string[];
export const LIVE_KEY_RE: RegExp;
export function checkEnvVars(input: unknown): Record<string, string>;
export function dbNameOf(slug: string): string;
export function dbVars(slug: string, password: string): Record<string, string>;
export function envFileText(vars: Record<string, string>, db: Record<string, string> | null): string;
export function checkScriptPath(value: unknown): string;
export function idsOf(passwdText: string, user: string): { uid: number; gid: number };

export class OpError extends Error {
  status: number;
  constructor(status: number, message: string);
}

export type CronEvery = "5m" | "15m" | "30m" | "1h" | "1d";
export type CronSpec = { script: string; every: CronEvery };
export type CronLast = { start: string; durationSec: number; code: number | null; timedOut: boolean; skipped: boolean };
export const CRON_EVERY: Record<CronEvery, { at(minute: number): string; maxSec: number }>;
export const LOG_FILES: Record<"php" | "fpm" | "nginx" | "cron", string>;
export function checkCron(input: unknown): CronSpec;
export function cronLine(slug: string, cron: CronSpec): string;

export type SiteSpec = {
  slug: string;
  hostname: string;
  php: string;
  publicDir: string;
  persistentDirs: string[];
  publicPersistentDirs: string[];
  memoryLimitMb: number;
  uploadMaxMb: number;
  maxExecutionSec: number;
  cron: CronSpec | null;
  indexing: boolean;
};

export type Paths = {
  sitesDir: string;
  confDir: string;
  nginxSitesDir: string;
  nginxPort: number;
  runDir: string;
  initDir: string;
  confdDir: string;
  passwdFile: string;
  /** Crontabs de BusyBox (/etc/crontabs par défaut). */
  crontabsDir?: string;
};

export type RunResult = { code: number; stdout: string; stderr: string; timedOut?: boolean };

export type RunIo = {
  input?: string;
  inputFile?: string;
  gunzip?: boolean;
  outputFile?: string;
  gzip?: boolean;
  uid?: number;
  gid?: number;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutput?: number;
};

export type Sys = {
  run(file: string, args: string[]): Promise<RunResult>;
  readFile(p: string): Promise<string>;
  writeFile(p: string, text: string, mode: number): Promise<void>;
  mkdir(p: string, mode: number): Promise<void>;
  rm(p: string): Promise<void>;
  symlink(target: string, p: string): Promise<void>;
  rename(a: string, b: string): Promise<void>;
  readdir(p: string): Promise<string[]>;
  chown(p: string, user: string, group: string): Promise<void>;
  exists(p: string): Promise<boolean>;
  cp(a: string, b: string): Promise<void>;
  runIo(file: string, args: string[], io?: RunIo): Promise<RunResult>;
};

export type SiteContext = {
  paths: Paths;
  domain: string;
  phpInstalled(): string[];
  limitsEffective(): boolean;
  /** Statut HTTP de nginx local pour ce nom d'hôte et ce chemin. */
  httpStatus(host: string, path: string): Promise<number>;
  sys: Sys;
};

export type DbState = { slug: string; exists: boolean; name: string | null; bytes: number; tables: number; dumps: number[] };

export type SiteOperations = {
  incomingFile(slug: string, nonce: string, kind?: "version" | "sql" | "sqlgz"): Promise<string>;
  upsert(input: unknown): Promise<{ slug: string; uid: number; created: boolean }>;
  receive(slug: string, n: number, archivePath: string): Promise<{ slug: string; version: number }>;
  publish(slug: string, n: number): Promise<{ slug: string; current: number }>;
  setEnabled(slug: string, enabled: boolean): Promise<{ slug: string; enabled: boolean }>;
  check(slug: string): Promise<{ slug: string; ok: boolean; results: Array<{ path: string; status: number }> }>;
  remove(slug: string): Promise<{ slug: string; removed: boolean }>;
  setEnv(slug: string, input: unknown): Promise<{ slug: string; names: string[] }>;
  dbState(slug: string): Promise<DbState>;
  createDb(slug: string): Promise<DbState>;
  importDb(slug: string, file: string, gz: boolean): Promise<DbState>;
  exportDb(slug: string): Promise<{ file: string }>;
  resetDb(slug: string): Promise<DbState>;
  dumpBefore(slug: string, n: number): Promise<{ slug: string; dumped: boolean; version?: number }>;
  restoreDump(slug: string, n: number): Promise<DbState>;
  cronState(slug: string): Promise<{ slug: string; cron: CronSpec | null; line: string | null; maxSec: number | null; active: boolean; last: CronLast | null; output: string }>;
  logs(slug: string, kind: string, lines: number): Promise<{ slug: string; kind: string; text: string }>;
  runScript(slug: string, rel: unknown, args?: unknown, stdin?: unknown): Promise<{ slug: string; script: string; code: number; timedOut: boolean; durationMs: number; output: string }>;
};

export function checkRelDir(value: unknown, allowEmpty: boolean): string;
export function checkSiteSpec(input: unknown, ctx: Pick<SiteContext, "domain" | "phpInstalled">): SiteSpec;
export function userOf(slug: string): string;
export function serviceOf(slug: string): string;
export function allocateUid(passwdText: string, user: string): { uid: number; exists: boolean };
export const CHECK_PATHS: string[];
export function nginxConf(spec: SiteSpec, paths: Paths): string;
export function fpmConf(spec: SiteSpec, paths: Paths): string;
export function postMaxMb(spec: Pick<SiteSpec, "uploadMaxMb">): number;
export function siteMemoryMb(spec: Pick<SiteSpec, "memoryLimitMb">): number;
export function serviceConf(spec: SiteSpec, limits: boolean): string;
export function checkArchiveListing(text: string): string[];
export function siteOperations(ctx: SiteContext): SiteOperations;
export function fileSha256(file: string): Promise<string>;
export function realSys(run: Sys["run"]): Sys;
export function runIo(file: string, args: string[], io?: RunIo): Promise<RunResult>;
