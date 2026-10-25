// Types des opérations de l'agent sur les sites (sites.mjs), pour les tests du hub.

export const SITE_UID_MIN: number;
export const SITE_UID_MAX: number;
export const RELEASES_KEPT: number;
export const SLUG_RE: RegExp;

export class OpError extends Error {
  status: number;
  constructor(status: number, message: string);
}

export type SiteSpec = { slug: string; hostname: string; php: string; publicDir: string; persistentDirs: string[]; indexing: boolean };

export type Paths = {
  sitesDir: string;
  confDir: string;
  nginxSitesDir: string;
  nginxPort: number;
  runDir: string;
  initDir: string;
  confdDir: string;
  passwdFile: string;
};

export type RunResult = { code: number; stdout: string; stderr: string };

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

export type SiteOperations = {
  incomingFile(slug: string, nonce: string): Promise<string>;
  upsert(input: unknown): Promise<{ slug: string; uid: number; created: boolean }>;
  receive(slug: string, n: number, archivePath: string): Promise<{ slug: string; version: number }>;
  publish(slug: string, n: number): Promise<{ slug: string; current: number }>;
  setEnabled(slug: string, enabled: boolean): Promise<{ slug: string; enabled: boolean }>;
  check(slug: string): Promise<{ slug: string; ok: boolean; results: Array<{ path: string; status: number }> }>;
  remove(slug: string): Promise<{ slug: string; removed: boolean }>;
};

export function checkRelDir(value: unknown, allowEmpty: boolean): string;
export function checkSiteSpec(input: unknown, ctx: Pick<SiteContext, "domain" | "phpInstalled">): SiteSpec;
export function userOf(slug: string): string;
export function serviceOf(slug: string): string;
export function allocateUid(passwdText: string, user: string): { uid: number; exists: boolean };
export const CHECK_PATHS: string[];
export function nginxConf(spec: SiteSpec, paths: Paths): string;
export function fpmConf(spec: SiteSpec, paths: Paths): string;
export function serviceConf(spec: SiteSpec, limits: boolean): string;
export function checkArchiveListing(text: string): string[];
export function siteOperations(ctx: SiteContext): SiteOperations;
export function fileSha256(file: string): Promise<string>;
export function realSys(run: Sys["run"]): Sys;
