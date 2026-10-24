// Types de l'agent (agent.mjs), pour les tests du hub qui le lancent tel quel.
import type { Server } from "node:http";

export type ServiceState = "running" | "stopped" | "absent";

export type Probes = {
  alpine(): string | null;
  php(): string[];
  service(name: string): Promise<ServiceState>;
  cgroups(): { result: "ok" | "echec" | null; checkedAt: string | null };
  lastUpgrade(): string | null;
  disk(): { freeBytes: number; totalBytes: number } | null;
  sites(): number;
  now(): number;
};

export const AGENT_VERSION: string;
export const WINDOW_SECONDS: number;
export const systemProbes: Probes;
export function sha256Hex(body: string | Buffer | undefined): string;
export function signRequest(secret: string, timestamp: string, nonce: string, method: string, path: string, body: string | Buffer | undefined): string;
export function signResponse(secret: string, nonce: string, status: number, body: string): string;
export function createAgent(options: { secret: string; allowedIps: string[]; probes?: Probes; log?: (line: string) => void }): Server;
