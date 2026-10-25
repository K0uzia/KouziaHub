import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { PhpAgentState } from "@/contract.js";
import { audit } from "@/lib/audit.js";
import { HttpError } from "@/lib/http.js";
import { PhpAgentOpError, PhpAgentUnavailableError, type PhpAgentClient } from "@/lib/php-agent/client.js";
import type { Services } from "@/lib/services.js";
import { writeTarGz } from "@/lib/tar.js";

// Mise à jour du CT PHP par le hub, sans commande manuelle : l'archive des scripts du CT vient seulement du dépôt
// du hub (scripts/php-ct), jamais d'Internet ; l'agent la contrôle, lance install.sh, puis se relance.

/** Scripts du CT PHP dans le dépôt du hub (apps/api/src/lib : quatre niveaux sous la racine). */
export const PHP_CT_DIR = path.resolve(import.meta.dirname, "../../../../scripts/php-ct");

type ScriptFile = { rel: string; abs: string; size: number };

async function listFiles(dir: string, base = dir): Promise<ScriptFile[]> {
  const out: ScriptFile[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(abs, base)));
    else if (entry.isFile()) out.push({ rel: path.relative(base, abs).split(path.sep).join("/"), abs, size: (await stat(abs)).size });
  }
  return out;
}

/**
 * Empreinte des scripts du CT : chemins et contenus, dans un ordre fixe. Même dépôt, même empreinte ; c'est la
 * « version disponible » comparée à celle que l'agent a installée.
 */
export async function phpCtDigest(dir = PHP_CT_DIR): Promise<string> {
  const hash = createHash("sha256");
  for (const f of await listFiles(dir)) hash.update(`${f.rel}\0${createHash("sha256").update(await readFile(f.abs)).digest("hex")}\n`);
  return hash.digest("hex");
}

export type PhpCtUpdateResult = { ok: boolean; digest: string; log: string; state: PhpAgentState | null };

/**
 * Envoie les scripts à l'agent et attend son retour sur la nouvelle copie (état relu, empreinte installée). Échec :
 * l'agent a remis l'installation d'avant ; le journal d'install.sh est rendu tel quel (sans couleurs).
 */
export async function pushPhpCtScripts(agent: PhpAgentClient, dataDir: string, dir = PHP_CT_DIR, waitMs = 60_000): Promise<PhpCtUpdateResult> {
  const digest = await phpCtDigest(dir);
  const files = await listFiles(dir);
  const tmp = path.join(dataDir, "tmp");
  await mkdir(tmp, { recursive: true });
  const archive = path.join(tmp, `php-ct-${digest.slice(0, 12)}-${Date.now()}.tar.gz`);
  let result: { ok: boolean; log: string };
  try {
    const { sha256 } = await writeTarGz(
      files.map((f) => ({ path: `php-ct/${f.rel}`, size: f.size, read: () => readFile(f.abs) })),
      archive,
    );
    result = await agent.updateScripts(digest, { file: archive, sha256 });
  } catch (err) {
    if (err instanceof PhpAgentOpError && err.status === 404) {
      throw new HttpError(409, "L'agent du CT PHP ne sait pas encore se mettre à jour : refaire une dernière fois les commandes de la section 11.5 du README.", "php_agent_old");
    }
    throw err;
  } finally {
    await rm(archive, { force: true });
  }
  if (!result.ok) return { ok: false, digest, log: result.log, state: await agent.state().catch(() => null) };

  // L'agent répond puis se relance : état relu jusqu'à ce qu'il annonce la nouvelle empreinte.
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1500));
    const state = await agent.state().catch(() => null);
    if (state?.scripts?.digest === digest) return { ok: true, digest, log: result.log, state };
  }
  return { ok: false, digest, log: `${result.log}\nScripts installés, mais l'agent ne répond pas sur la nouvelle copie après ${waitMs / 1000} s.`, state: null };
}

/** Mise à jour complète, journalisée ; une notification part sur le téléphone en cas d'échec. */
export async function updatePhpCt(services: Pick<Services, "phpAgent" | "dataDir" | "push">): Promise<PhpCtUpdateResult> {
  if (!services.phpAgent) throw new HttpError(503, "Serveur des sites PHP non relié (hubctl secrets php, README section 11.8).", "php_unavailable");
  let r: PhpCtUpdateResult;
  try {
    r = await pushPhpCtScripts(services.phpAgent, services.dataDir);
  } catch (err) {
    const message = err instanceof HttpError || err instanceof PhpAgentUnavailableError || err instanceof PhpAgentOpError ? err.message : "échec inattendu";
    await audit({ action: "php.ct.update", result: "error", detail: message });
    await alert(services, message);
    throw err instanceof PhpAgentUnavailableError ? new HttpError(503, err.message, "php_unavailable") : err;
  }
  await audit({ action: "php.ct.update", result: r.ok ? "ok" : "error", detail: `scripts ${r.digest.slice(0, 12)}${r.ok ? "" : " : échec, installation d'avant remise"}` });
  if (!r.ok) await alert(services, "Mise à jour du serveur des sites PHP en échec : l'installation d'avant est remise (journal dans les Réglages du hub).");
  return r;
}

async function alert(services: Pick<Services, "push">, body: string): Promise<void> {
  await services.push
    .sendToAll({ title: "Serveur des sites PHP", body, url: "/reglages", tag: "php-ct-update", urgent: true })
    .catch(() => undefined);
}
