// Lancement de Chromium commun aux vignettes et à la mesure de vitesse : bac à sable obligatoire,
// utilisateur dédié en production (lanceur doas de HUB_CHROMIUM_PATH), essai par pipe puis par port
// 127.0.0.1 et connexion CDP, arrêt par Browser.close (le hub ne peut pas tuer un processus d'un autre
// utilisateur).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { isProduction } from "@/lib/env.js";

/** Chromium utilisable, null sinon (repli de chaque usage). */
export async function resolveChromium(explicit?: string | null): Promise<string | null> {
  if (explicit === null) return null;
  const configured = explicit ?? process.env.HUB_CHROMIUM_PATH?.trim();
  if (configured) return existsSync(configured) ? configured : null;
  try {
    const { chromium } = await import("playwright-core");
    const candidate = chromium.executablePath();
    return candidate && existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export type ChromiumConfig = {
  /**
   * Exécutable : Chromium, ou le lanceur qui le démarre sous l'utilisateur dédié (CT :
   * /usr/local/lib/kouziahub/chromium-launch). null : aucun ; undefined : HUB_CHROMIUM_PATH ou
   * Chromium de playwright-core.
   */
  chromiumPath?: string | null;
  /** Utilisateur dédié ; undefined : HUB_CHROMIUM_USER. */
  chromiumUser?: string | null;
  /** undefined : NODE_ENV=production. */
  production?: boolean;
  /** undefined : processus courant sous root. */
  isRoot?: boolean;
};

export type ChromiumLauncher = { ok: true; executablePath: string; viaUser: string | null } | { ok: false; reason: string };

/**
 * Lanceur, sans démarrer Chromium. Le JavaScript chargé n'est jamais de confiance : bac à sable
 * obligatoire, jamais de repli sans. En production, Chromium tourne sous l'utilisateur dédié (sans accès
 * au .env ni aux données du hub) ; sans lui, l'usage (`what`) est désactivé avec la raison.
 */
export async function chromiumLauncher(what: string, config: ChromiumConfig = {}): Promise<ChromiumLauncher> {
  const user = config.chromiumUser === undefined ? process.env.HUB_CHROMIUM_USER?.trim() || null : config.chromiumUser;
  const production = config.production ?? isProduction();
  if (!user && production) return { ok: false, reason: `${what} désactivée : utilisateur dédié de Chromium non configuré (HUB_CHROMIUM_USER).` };
  const root = config.isRoot ?? (typeof process.getuid === "function" && process.getuid() === 0);
  if (!user && root) return { ok: false, reason: `${what} désactivée : sous root, Chromium refuse le bac à sable.` };
  const executablePath = await resolveChromium(config.chromiumPath);
  if (!executablePath) {
    return { ok: false, reason: user ? `${what} désactivée : lanceur de Chromium (HUB_CHROMIUM_PATH) absent pour ${user}.` : `Chromium absent : ${what.toLowerCase()} indisponible.` };
  }
  return { ok: true, executablePath, viaUser: user };
}

type Chromium = (typeof import("playwright-core"))["chromium"];
export type ChromiumLaunchOptions = NonNullable<Parameters<Chromium["launch"]>[0]>;
export type Browser = Awaited<ReturnType<Chromium["launch"]>>;
export type SpawnBrowser = (executablePath: string, args: string[]) => ChildProcess;

/** Arguments communs : jamais --no-sandbox. */
export const BASE_ARGS = ["--no-first-run", "--disable-background-networking"];

/**
 * Arguments du lancement par port : port choisi par Chromium sur 127.0.0.1, bac à sable jamais coupé.
 * Le profil est réécrit par le lanceur sous l'utilisateur dédié.
 */
export const portLaunchArgs = (extra: string[]): string[] => [
  "--headless=new",
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=0",
  ...BASE_ARGS,
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-sync",
  "--mute-audio",
  ...extra,
  "about:blank",
];

/**
 * Arrêt du lanceur sans jamais lever. Sous doas, Chromium tourne sous le compte kouziahub-chromium : kill renvoie
 * EPERM, que Node émet en événement « error » (levé faute d'écouteur). Chromium se ferme alors par CDP.
 */
export function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.on("error", () => undefined);
  try {
    child.kill();
  } catch {
    // Autre compte : rien à faire de plus ici.
  }
}

/** Attend la fin du processus, au plus ms millisecondes. */
function exited(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Chromium démarré par son lanceur avec --remote-debugging-port=0 : l'adresse CDP est lue sur sa sortie
 * d'erreur (« DevTools listening on ws://... »), refusée si elle n'est pas en 127.0.0.1.
 */
export function startForCdp(
  executablePath: string,
  spawnBrowser: SpawnBrowser,
  timeoutMs: number,
  extra: string[] = [],
): Promise<{ wsUrl: string; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawnBrowser(executablePath, portLaunchArgs(extra));
    let stderr = "";
    let settled = false;
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopChild(child);
      reject(new Error(reason));
    };
    const timer = setTimeout(() => fail("adresse DevTools non reçue à temps"), timeoutMs);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
      const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
      if (!m) return;
      if (new URL(m[1]!).hostname !== "127.0.0.1") return fail("adresse DevTools hors de 127.0.0.1");
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ wsUrl: m[1]!, child });
    });
    child.once("error", (err) => fail(err.message));
    child.once("exit", (code) => fail(`lanceur arrêté (code ${code ?? "inconnu"}) : ${stderr.trim().split(/\r?\n/).pop()?.slice(0, 120) ?? ""}`));
  });
}

export type StartOptions = {
  timeoutMs: number;
  /** Arguments propres à l'usage (ex. --host-resolver-rules des vignettes). */
  args?: string[];
  /** Pour les tests : lancement par pipe, démarrage du lanceur, connexion CDP. */
  launch?: (o: ChromiumLaunchOptions) => Promise<Browser>;
  spawnBrowser?: SpawnBrowser;
  connect?: (wsUrl: string) => Promise<Browser>;
};

export type StartedChromium = { browser: Browser; via: "pipe" | "port"; close: () => Promise<void> };

/** Erreur de démarrage avec les deux causes, affichable telle quelle. */
export class ChromiumStartError extends Error {}

const firstLine = (err: unknown) => (err instanceof Error ? err.message.split(/\r?\n/)[0]!.slice(0, 120) : "lancement impossible");

/**
 * Démarre Chromium (bac à sable actif) : par pipe, défaut de Playwright ; si le lanceur ferme les
 * descripteurs 3 et 4 (doas), par port 127.0.0.1 puis connexion CDP. `close` arrête Chromium.
 */
export async function startChromium(executablePath: string, options: StartOptions): Promise<StartedChromium> {
  const args = [...BASE_ARGS, ...(options.args ?? [])];
  const launch = options.launch ?? (async (o: ChromiumLaunchOptions) => (await import("playwright-core")).chromium.launch(o));
  const spawnBrowser: SpawnBrowser = options.spawnBrowser ?? ((exe, a) => spawn(exe, a, { stdio: ["ignore", "ignore", "pipe"] }));
  const connect = options.connect ?? (async (ws: string) => (await import("playwright-core")).chromium.connectOverCDP(ws, { timeout: options.timeoutMs }));
  try {
    const browser = await launch({ executablePath, headless: true, timeout: options.timeoutMs, chromiumSandbox: true, args });
    return { browser, via: "pipe", close: () => browser.close().catch(() => undefined) };
  } catch (pipeErr) {
    let child: ChildProcess | null = null;
    try {
      const started = await startForCdp(executablePath, spawnBrowser, Math.min(options.timeoutMs, 30_000), options.args ?? []);
      child = started.child;
      const browser = await connect(started.wsUrl);
      const proc = child;
      return {
        browser,
        via: "port",
        close: async () => {
          const cdp = await browser.newBrowserCDPSession().catch(() => null);
          await cdp?.send("Browser.close").catch(() => undefined);
          await browser.close().catch(() => undefined);
          await exited(proc, 5_000);
          stopChild(proc);
        },
      };
    } catch (portErr) {
      if (child) stopChild(child);
      throw new ChromiumStartError(`Chromium ne démarre pas avec son bac à sable (pipe : ${firstLine(pipeErr)} ; port : ${firstLine(portErr)})`);
    }
  }
}
