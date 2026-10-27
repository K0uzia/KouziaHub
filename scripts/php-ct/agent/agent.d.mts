// Types de l'agent (agent.mjs), pour les tests du hub qui le lancent tel quel.
import type { Server } from "node:http";
import type { SiteOperations } from "./sites.mjs";
import type { CtOperations } from "./update.mjs";
import type { MailStore } from "./mail.mjs";

export type ServiceState = "running" | "stopped" | "absent";

export type Probes = {
  alpine(): string | null;
  php(): string[];
  service(name: string): Promise<ServiceState>;
  cgroups(): { result: "ok" | "echec" | null; checkedAt: string | null };
  lastUpgrade(): string | null;
  disk(): { freeBytes: number; totalBytes: number } | null;
  /** Mémoire du CT en octets (/proc/meminfo, lxcfs), null si illisible. */
  memory?(): number | null;
  sites(): number;
  tunnelId(): string | null;
  now(): number;
};

export const AGENT_VERSION: string;
export const WINDOW_SECONDS: number;
export const systemProbes: Probes;
export function sha256Hex(body: string | Buffer | undefined): string;
export function signRequest(secret: string, timestamp: string, nonce: string, method: string, path: string, body: string | Buffer | undefined): string;
export function signResponse(secret: string, nonce: string, status: number, body: string): string;
export function signResponseHash(secret: string, nonce: string, status: number, bodySha256: string): string;
export const MAX_UPLOAD_BYTES: number;
export function tunnelIdOf(token: string | null): string | null;
export function createAgent(options: {
  secret: string;
  allowedIps: string[];
  probes?: Probes;
  sites?: Partial<SiteOperations> | null;
  mails?: MailStore | null;
  ct?: CtOperations | null;
  restart?: () => void;
  log?: (line: string) => void;
  /** Numéros déjà reçus, gardés sur disque (rejeu refusé après un redémarrage). */
  nonceFile?: string | null;
}): Server;
