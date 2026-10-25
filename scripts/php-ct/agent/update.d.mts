// Types de la mise à jour des scripts du CT (update.mjs), pour les tests du hub.
import type { Sys } from "./sites.mjs";

export const DIGEST_RE: RegExp;
export type ScriptsVersion = { digest: string | null; installedAt: string | null; result: "ok" | "echec" | null };
export type CtOperations = {
  incomingFile(nonce: string): Promise<string>;
  version(): Promise<ScriptsVersion>;
  updateScripts(archive: string, digest: string): Promise<{ ok: boolean; digest: string; log: string; restart: boolean }>;
};
export function ctOperations(ctx: { stateDir: string; libDir: string; initDir: string; sys: Sys; now(): number }): CtOperations;
