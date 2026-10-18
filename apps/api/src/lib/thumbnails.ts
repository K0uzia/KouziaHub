import { mkdir, rename, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import sharp from "sharp";
import { audit } from "@/lib/audit.js";
import type { BlobStore } from "@/lib/blobs.js";
import { chromiumLauncher, startChromium, type ChromiumConfig, type StartOptions } from "@/lib/chromium.js";
import { contentTypeWithCharset } from "@/lib/mime.js";
import { prisma } from "@/lib/prisma.js";

export const THUMB_WIDTH = 640;
export const THUMB_HEIGHT = 400;

/**
 * CSP du serveur éphémère de capture : seul 127.0.0.1:<port> est joignable (connect-src couvre fetch,
 * XHR et WebSocket), en plus de l'interception des requêtes par Chromium.
 */
export const CAPTURE_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; " +
  "worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";

export { resolveChromium } from "@/lib/chromium.js";

/** Chromium ne résout aucun nom : seul 127.0.0.1 (serveur éphémère) est joignable. */
const CAPTURE_ARGS = ["--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"];

export type ThumbnailOptions = ChromiumConfig & {
  dataDir: string;
  blobs: BlobStore;
  timeoutMs?: number;
  /** Pour les tests : lancement par pipe, démarrage du lanceur, connexion CDP (lib/chromium.ts). */
  start?: Pick<StartOptions, "launch" | "spawnBrowser" | "connect">;
};

/** Image redimensionnée en WebP 640 x 400 (recadrée au centre). */
export async function toThumbnail(input: Buffer): Promise<Buffer> {
  return sharp(input, { limitInputPixels: 50_000_000 })
    .rotate()
    .resize(THUMB_WIDTH, THUMB_HEIGHT, { fit: "cover", position: "top" })
    .webp({ quality: 78 })
    .toBuffer();
}

/**
 * Vignettes : capture de la version publiée par Chromium sans aucun réseau extérieur (serveur éphémère
 * sur 127.0.0.1, toute autre requête abandonnée), une capture à la fois, jamais bloquante.
 */
export class ThumbnailService {
  private queue: Promise<void> = Promise.resolve();
  private readonly pending = new Set<string>();
  /** Dernier échec de lancement (bac à sable refusé, lanceur en erreur), pour l'état affiché. */
  private lastLaunchFailure: string | null = null;
  /** Requêtes hors 127.0.0.1 abandonnées pendant la dernière capture (contrôle : aucun réseau extérieur). */
  lastBlocked: string[] = [];
  /** Mode de lancement de la dernière capture (contrôle des tests). */
  lastVia: "pipe" | "port" | null = null;

  constructor(private readonly options: ThumbnailOptions) {}

  /** Capture automatique disponible, ou la raison (repli : image envoyée). Même lanceur que la vitesse. */
  async captureStatus(): Promise<{ available: boolean; reason: string | null }> {
    const launcher = await chromiumLauncher("Capture des vignettes", this.options);
    if (!launcher.ok) return { available: false, reason: launcher.reason };
    return this.lastLaunchFailure ? { available: false, reason: this.lastLaunchFailure } : { available: true, reason: null };
  }

  async captureAvailable(): Promise<boolean> {
    return (await this.captureStatus()).available;
  }

  /** auto : capture après publication, sautée si Alexandre a choisi une image envoyée. */
  enqueue(siteId: string, opts: { auto?: boolean } = {}): void {
    if (this.pending.has(siteId)) return;
    this.pending.add(siteId);
    this.queue = this.queue
      .then(async () => {
        this.pending.delete(siteId);
        const site = await prisma.site.findUnique({ where: { id: siteId }, select: { thumbnailSource: true } });
        if (!site || (opts.auto && site.thumbnailSource === "upload")) return;
        await this.capture(siteId);
      })
      .catch((err) => console.error("[vignette] capture impossible", err instanceof Error ? err.message : err));
  }

  /** Attend la fin des captures en file (tests, arrêt). */
  async idle(): Promise<void> {
    await this.queue;
  }

  async save(siteId: string, image: Buffer, source: "capture" | "upload"): Promise<void> {
    const dir = path.join(this.options.dataDir, "thumbnails");
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `${siteId}.webp.tmp`);
    await writeFile(tmp, image);
    await rename(tmp, path.join(dir, `${siteId}.webp`));
    await prisma.site.update({
      where: { id: siteId },
      data: { thumbnailPath: `thumbnails/${siteId}.webp`, thumbnailSource: source, thumbnailAt: new Date() },
    });
  }

  /** Capture de la version servie ; false si impossible (Chromium absent, page d'attente, délai). */
  async capture(siteId: string): Promise<boolean> {
    const launcher = await chromiumLauncher("Capture des vignettes", this.options);
    if (!launcher.ok) return false;
    const site = await prisma.site.findUnique({ where: { id: siteId } });
    if (!site?.currentVersionId) return false;
    const version = await prisma.version.findUnique({ where: { id: site.currentVersionId }, include: { files: true } });
    if (!version || version.source === "placeholder" || version.files.length === 0) return false;
    const files = new Map(version.files.map((f) => [f.path, f.sha256]));

    const server = await this.serveVersion(files);
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    let started: Awaited<ReturnType<typeof startChromium>> | null = null;
    const blocked: string[] = [];
    this.lastBlocked = blocked;
    this.lastVia = null;
    const deadline = setTimeout(() => void started?.close(), timeoutMs);
    try {
      try {
        started = await startChromium(launcher.executablePath, { timeoutMs, args: CAPTURE_ARGS, ...this.options.start });
        this.lastLaunchFailure = null;
        this.lastVia = started.via;
      } catch (err) {
        this.lastLaunchFailure = `Capture des vignettes désactivée : ${err instanceof Error ? err.message : "lancement impossible"}.`;
        throw err;
      }
      const browser = started.browser;
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block", acceptDownloads: false });
      await context.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith(`${origin}/`) || url === origin) return route.continue();
        blocked.push(url);
        return route.abort();
      });
      await context.routeWebSocket(
        () => true,
        (ws) => {
          blocked.push(ws.url());
          void ws.close();
        },
      );
      const page = await context.newPage();
      await page.goto(`${origin}/`, { waitUntil: "load", timeout: timeoutMs });
      await page.waitForTimeout(400);
      const png = await page.screenshot({ type: "png", timeout: timeoutMs });
      await this.save(siteId, await toThumbnail(png), "capture");
      await audit({ action: "thumbnail.capture", result: "ok", siteId, siteSlug: site.slug });
      return true;
    } catch (err) {
      await audit({ action: "thumbnail.capture", result: "error", siteId, siteSlug: site.slug, detail: "capture impossible" });
      console.error("[vignette] capture impossible", err instanceof Error ? err.message : err);
      return false;
    } finally {
      clearTimeout(deadline);
      await started?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** Serveur éphémère des fichiers d'une version, sur 127.0.0.1 et un port aléatoire. */
  serveVersion(files: Map<string, string>): Promise<Server> {
    const blobs = this.options.blobs;
    const server = createServer((req, res) => {
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname).replace(/^\/+/, "");
      } catch {
        res.writeHead(400).end();
        return;
      }
      const candidates = [pathname, pathname === "" || pathname.endsWith("/") ? `${pathname}index.html` : `${pathname}/index.html`, `${pathname}.html`];
      const found = candidates.find((p) => files.has(p));
      if (!found || (req.method !== "GET" && req.method !== "HEAD")) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": CAPTURE_CSP }).end("404");
        return;
      }
      res.writeHead(200, { "Content-Type": contentTypeWithCharset(found), "Cache-Control": "no-store", "Content-Security-Policy": CAPTURE_CSP });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      blobs
        .stream(files.get(found)!)
        .on("error", () => res.destroy())
        .pipe(res);
    });
    server.keepAliveTimeout = 1000;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
  }
}
