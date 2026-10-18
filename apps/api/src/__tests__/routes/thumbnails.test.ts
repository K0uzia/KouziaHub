import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import type { SiteDetail } from "@/contract.js";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "@/lib/blobs.js";
import { CAPTURE_CSP, resolveChromium, ThumbnailService } from "@/lib/thumbnails.js";
import { resetDb } from "../helpers/db.js";
import { buildTestHub, createPersoSite, multipart, settle, uploadFiles, type TestHub } from "../helpers/hub.js";

let hub: TestHub | null = null;
afterEach(async () => {
  await hub?.app.close();
  hub = null;
});

const chromium = await resolveChromium();

async function setup(chromiumPath: string | null) {
  await resetDb();
  hub = await buildTestHub({ chromiumPath });
  const siteId = await createPersoSite(hub, "alpha");
  return { hub, siteId };
}

describe("vignette envoyée (repli)", () => {
  it("convertit l'image en WebP 640 x 400 servie en privé", async () => {
    const { hub, siteId } = await setup(null);
    const png = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: "#3366cc" } }).png().toBuffer();
    const body = multipart([], [{ field: "image", filename: "capture.png", content: png, type: "image/png" }]);
    const res = await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/thumbnail`, headers: { ...hub.headers, ...body.headers }, payload: body.payload });
    expect(res.statusCode).toBe(200);
    const site = res.json() as SiteDetail;
    expect(site.thumbnailSource).toBe("upload");
    expect(site.thumbnailUrl).toMatch(new RegExp(`^/api/sites/${siteId}/thumbnail\\?v=\\d+$`));
    const img = await hub.app.inject({ method: "GET", url: site.thumbnailUrl!, headers: hub.headers });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/webp");
    expect(img.headers["cache-control"]).toMatch(/^private/);
    const meta = await sharp(img.rawPayload).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 640, 400]);
  });

  it("refuse un fichier qui n'est pas une image, ou un faux PNG", async () => {
    const { hub, siteId } = await setup(null);
    const send = (content: Buffer | string, type: string) => {
      const body = multipart([], [{ filename: "x", content, type }]);
      return hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/thumbnail`, headers: { ...hub.headers, ...body.headers }, payload: body.payload });
    };
    expect((await send("<svg onload=alert(1)/>", "image/svg+xml")).statusCode).toBe(400);
    expect((await send("pas une image", "image/png")).statusCode).toBe(400);
    expect((await send("texte", "text/plain")).statusCode).toBe(400);
  });

  it("capture indisponible sans Chromium : 409 explicite, pas de vignette", async () => {
    const { hub, siteId } = await setup(null);
    const res = await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/thumbnail/capture`, headers: hub.headers });
    expect(res.statusCode).toBe(409);
    expect((await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/thumbnail`, headers: hub.headers })).statusCode).toBe(404);
  });
});

describe("serveur éphémère de capture", () => {
  it("pose une CSP stricte (connect-src 'self') sur chaque réponse", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouzia-hub-thumb-"));
    const blobs = new BlobStore(dataDir);
    const { sha256 } = await blobs.putBuffer(Buffer.from("<h1>x</h1>"));
    const server = await new ThumbnailService({ dataDir, blobs, chromiumPath: null }).serveVersion(new Map([["index.html", sha256]]));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (const path of ["/", "/absent.css"]) {
        const res = await fetch(base + path);
        expect(res.headers.get("content-security-policy")).toBe(CAPTURE_CSP);
      }
      expect(CAPTURE_CSP).toContain("connect-src 'self'");
      expect(CAPTURE_CSP).toContain("default-src 'self'");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe.skipIf(!chromium)("capture automatique (Chromium local)", () => {
  it("capture la version publiée sans réseau extérieur, après la publication", { timeout: 60_000 }, async () => {
    const { hub, siteId } = await setup(chromium);
    const html =
      '<!doctype html><html><head><link rel="stylesheet" href="/s.css"></head>' +
      '<body><h1>Alpha</h1><img src="https://example.com/pixel.png" alt="">' +
      '<script>try { new WebSocket("ws://" + location.host + "/ws"); } catch (e) {}</script></body></html>';
    await uploadFiles(hub, siteId, [
      { filename: "index.html", content: html },
      { filename: "s.css", content: "body{background:#cc3300;margin:0}" },
    ]);
    await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/publish`, headers: hub.headers, payload: {} });
    await settle(hub);
    await hub.services.thumbnails.idle();
    const site = (await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}`, headers: hub.headers })).json() as SiteDetail;
    expect(site.thumbnailSource).toBe("capture");
    // L'image externe est arrêtée par la CSP avant même l'interception ; le WebSocket (même origine,
    // permis par la CSP) est coupé par routeWebSocket.
    expect(hub.services.thumbnails.lastBlocked.some((u) => u.startsWith("https://example.com"))).toBe(false);
    expect(hub.services.thumbnails.lastBlocked.some((u) => /^ws:\/\/127\.0\.0\.1:\d+\/ws$/.test(u))).toBe(true);
    const img = await hub.app.inject({ method: "GET", url: site.thumbnailUrl!, headers: hub.headers });
    const { data, info } = await sharp(img.rawPayload).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([640, 400]);
    // La feuille de style locale a été servie par le serveur éphémère : fond rouge orangé.
    const [r, g, b] = [data[info.width * 200 * info.channels + 300 * info.channels]!, data[info.width * 200 * info.channels + 300 * info.channels + 1]!, data[info.width * 200 * info.channels + 300 * info.channels + 2]!];
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(100);
    expect(b).toBeLessThan(60);
  });

  it("garde une image envoyée à la publication suivante (capture automatique sautée)", { timeout: 60_000 }, async () => {
    const { hub, siteId } = await setup(chromium);
    const png = await sharp({ create: { width: 800, height: 500, channels: 3, background: "#00aa00" } }).png().toBuffer();
    const thumb = multipart([], [{ filename: "t.png", content: png, type: "image/png" }]);
    await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/thumbnail`, headers: { ...hub.headers, ...thumb.headers }, payload: thumb.payload });
    await uploadFiles(hub, siteId, [{ filename: "index.html", content: "<h1>x</h1>" }]);
    await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/publish`, headers: hub.headers, payload: {} });
    await settle(hub);
    await hub.services.thumbnails.idle();
    const site = (await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}`, headers: hub.headers })).json() as SiteDetail;
    expect(site.thumbnailSource).toBe("upload");
  });
});
