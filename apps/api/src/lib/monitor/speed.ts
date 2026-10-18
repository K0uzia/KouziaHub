import { isIP } from "node:net";
import { resolveChromium } from "@/lib/thumbnails.js";

export type SpeedResult =
  | { available: true; ok: boolean; ttfbMs: number | null; lcpMs: number | null; cls: number | null; bytes: number | null; requests: number | null; error: string | null }
  | { available: false; reason: string };

/**
 * Adresse du réseau local ou de la machine : jamais chargée pendant la mesure (la page mesurée
 * ne doit pas servir de rebond vers le Proxmox ou la box). Contrôle sur le nom d'hôte de l'URL.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return true;
  const kind = isIP(host);
  if (kind === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (kind === 6) {
    return host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:");
  }
  return false;
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
 * Mesure de vitesse de l'accueil en profil mobile, par le Chromium du CT (même lanceur que les
 * vignettes). Sans Chromium : indisponible, proprement. `allowPrivate` sert aux tests seulement.
 */
export async function measureSpeed(
  url: string,
  options: { chromiumPath?: string | null; timeoutMs?: number; allowPrivate?: boolean } = {},
): Promise<SpeedResult> {
  const executablePath = await resolveChromium(options.chromiumPath);
  if (!executablePath) return { available: false, reason: "Chromium absent : mesure de vitesse indisponible." };
  const timeoutMs = options.timeoutMs ?? 45_000;
  const { chromium } = await import("playwright-core");
  const sandbox = typeof process.getuid === "function" ? process.getuid() !== 0 : true;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  const deadline = setTimeout(() => void browser?.close().catch(() => undefined), timeoutMs + 5000);
  try {
    const launch = (chromiumSandbox: boolean) => chromium.launch({ executablePath, headless: true, timeout: timeoutMs, chromiumSandbox, args: ["--no-first-run", "--disable-background-networking"] });
    try {
      browser = await launch(sandbox);
    } catch (err) {
      if (!sandbox) throw err;
      console.warn("[vitesse] Chromium refuse le bac à sable, lancement sans");
      browser = await launch(false);
    }
    const context = await browser.newContext({ ...MOBILE, serviceWorkers: "block", acceptDownloads: false });
    let requests = 0;
    let bytes = 0;
    await context.route("**/*", (route) => {
      let host = "";
      try {
        host = new URL(route.request().url()).hostname;
      } catch {
        return route.abort();
      }
      if (!options.allowPrivate && isPrivateHost(host)) return route.abort();
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
    await browser?.close().catch(() => undefined);
  }
}
