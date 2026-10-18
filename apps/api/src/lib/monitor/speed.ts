import { chromiumLauncher, startChromium, type Browser, type ChromiumConfig, type ChromiumLaunchOptions, type SpawnBrowser } from "@/lib/chromium.js";
import { resolvePublic, systemLookup, type HostLookup } from "@/lib/monitor/checks.js";

export { isPrivateHost } from "@/lib/monitor/checks.js";

export type SpeedResult =
  | { available: true; ok: boolean; ttfbMs: number | null; lcpMs: number | null; cls: number | null; bytes: number | null; requests: number | null; error: string | null }
  | { available: false; reason: string };

export type SpeedLaunchOptions = ChromiumConfig;

/** Lanceur de la mesure de vitesse (lib/chromium.ts) : utilisateur dédié en production, bac à sable obligatoire. */
export const speedLauncher = (options: SpeedLaunchOptions = {}) => chromiumLauncher("Mesure de vitesse", options);

/** Dernier échec de lancement (bac à sable refusé, lanceur en erreur), pour l'état affiché. */
let lastLaunchFailure: string | null = null;

/** État de la mesure de vitesse pour /api/system et l'onglet Surveillance. */
export async function speedStatus(options: SpeedLaunchOptions = {}): Promise<{ available: boolean; reason: string | null }> {
  const launcher = await speedLauncher(options);
  if (!launcher.ok) return { available: false, reason: launcher.reason };
  return lastLaunchFailure ? { available: false, reason: lastLaunchFailure } : { available: true, reason: null };
}

/**
 * Requête de la page mesurée autorisée ? http(s) seulement ; nom résolu (toutes ses adresses) et refusé
 * si UNE adresse est privée ; IP littérale privée refusée. Chromium refait sa propre résolution ensuite :
 * un nom qui change d'adresse entre les deux passerait, d'où le pare-feu du CT en complément.
 */
export async function speedRequestAllowed(rawUrl: string, lookup: HostLookup = systemLookup): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  try {
    await resolvePublic(url.hostname, lookup);
    return true;
  } catch {
    return false;
  }
}

const MOBILE = {
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 KouziaHub-Veille/1",
};

// Relevé LCP et CLS dès le début du chargement (observateurs en mode « buffered »).
const OBSERVE = `
window.__kz = { lcp: null, cls: 0 };
try {
  new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__kz.lcp = e.renderTime || e.loadTime || e.startTime; })
    .observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__kz.cls += e.value; })
    .observe({ type: "layout-shift", buffered: true });
} catch (e) {}
`;

/**
 * Mesure de vitesse de l'accueil en profil mobile, par le Chromium du CT, bac à sable obligatoire.
 * Lancement par pipe (défaut de Playwright) ; si le lanceur de l'utilisateur dédié ferme les
 * descripteurs 3 et 4 (doas), lancement par port 127.0.0.1 puis connexion CDP. Chaque requête de la page
 * est interceptée (Fetch.requestPaused du protocole CDP, par context.route) et abandonnée si son hôte
 * se résout vers une adresse privée ; les WebSocket sont fermés.
 * `allowPrivate`, `launch`, `spawnBrowser` et `connect` servent aux tests seulement.
 */
export async function measureSpeed(
  url: string,
  options: SpeedLaunchOptions & {
    timeoutMs?: number;
    allowPrivate?: boolean;
    lookup?: HostLookup;
    launch?: (o: ChromiumLaunchOptions) => Promise<Browser>;
    spawnBrowser?: SpawnBrowser;
    connect?: (wsUrl: string) => Promise<Browser>;
  } = {},
): Promise<SpeedResult> {
  const launcher = await speedLauncher(options);
  if (!launcher.ok) return { available: false, reason: launcher.reason };
  const timeoutMs = options.timeoutMs ?? 45_000;
  const lookup = options.lookup ?? systemLookup;
  let started: Awaited<ReturnType<typeof startChromium>> | null = null;
  const deadline = setTimeout(() => void started?.close(), timeoutMs + 5000);
  try {
    try {
      started = await startChromium(launcher.executablePath, { timeoutMs, launch: options.launch, spawnBrowser: options.spawnBrowser, connect: options.connect });
    } catch (err) {
      lastLaunchFailure = `Mesure de vitesse désactivée : ${err instanceof Error ? err.message : "lancement impossible"}.`;
      return { available: false, reason: lastLaunchFailure };
    }
    lastLaunchFailure = null;
    const browser = started.browser;
    const context = await browser.newContext({ ...MOBILE, serviceWorkers: "block", acceptDownloads: false });
    let requests = 0;
    let bytes = 0;
    await context.route("**/*", async (route) => {
      if (!options.allowPrivate && !(await speedRequestAllowed(route.request().url(), lookup))) return route.abort("blockedbyclient");
      return route.continue();
    });
    await context.routeWebSocket(
      () => true,
      (ws) => void ws.close(),
    );
    await context.addInitScript(OBSERVE);
    const page = await context.newPage();
    page.on("requestfinished", (req) => {
      requests++;
      void req
        .sizes()
        .then((s) => {
          bytes += s.responseBodySize + s.responseHeadersSize;
        })
        .catch(() => undefined);
    });
    const response = await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
    await page.waitForTimeout(2500);
    // Exécuté dans la page (chaîne : l'API n'embarque pas les types du DOM).
    const metrics = (await page.evaluate(`(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      const kz = window.__kz;
      return { ttfb: nav ? nav.responseStart - nav.startTime : null, lcp: kz ? kz.lcp : null, cls: kz ? kz.cls : null };
    })()`)) as { ttfb: number | null; lcp: number | null; cls: number | null };
    const round = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v));
    return {
      available: true,
      ok: Boolean(response && response.status() < 400),
      ttfbMs: round(metrics.ttfb),
      lcpMs: round(metrics.lcp),
      cls: metrics.cls === null ? null : Math.round(metrics.cls * 1000) / 1000,
      bytes,
      requests,
      error: response && response.status() >= 400 ? `statut ${response.status()}` : null,
    };
  } catch (err) {
    return { available: true, ok: false, ttfbMs: null, lcpMs: null, cls: null, bytes: null, requests: null, error: err instanceof Error ? err.message.split(/\r?\n/)[0]!.slice(0, 160) : "mesure impossible" };
  } finally {
    clearTimeout(deadline);
    await started?.close();
  }
}
