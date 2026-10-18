// Regroupement du Worker en un seul module ES (esbuild), partagé par « npm run veille:build » et le
// déploiement. Aucune dépendance Node dans le résultat : plateforme neutre, cible ES2022.
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WORKER_ENTRY = path.join(WORKER_DIR, "src", "index.ts");
export const WORKER_OUT = path.join(WORKER_DIR, "dist", "index.js");
export const SCHEMA_FILE = path.join(WORKER_DIR, "schema.sql");

/** Script regroupé, en mémoire ; écrit aussi dans dist/index.js si `outfile` est donné. */
export async function bundleWorker(outfile?: string): Promise<string> {
  const result = await build({
    entryPoints: [WORKER_ENTRY],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "browser"],
    minify: true,
    legalComments: "none",
    write: false,
    outfile: outfile ?? WORKER_OUT,
    logLevel: "silent",
  });
  const code = result.outputFiles[0]!.text;
  if (outfile) {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.dirname(outfile), { recursive: true });
    writeFileSync(outfile, code);
  }
  return code;
}
