import { spawn } from "node:child_process";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import type { SiteDetail } from "@/contract.js";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "@/lib/blobs.js";
import { CAPTURE_CSP, isUniform, resolveChromium, ThumbnailService } from "@/lib/thumbnails.js";
import { prisma, resetDb } from "../helpers/db.js";
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
  it("garde l'image envoyée à son ratio (WebP, 960 px au plus), servie en privé", async () => {
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
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 960, 600]);
    expect(site.thumbnailFocus).toBe("haut");
  });

  it("image haute gardée entière ; point d'intérêt enregistré sans nouveau traitement, valeur inconnue refusée", async () => {
    const { hub, siteId } = await setup(null);
    const tall = await sharp({ create: { width: 1200, height: 2400, channels: 3, background: "#e8eef5" } }).png().toBuffer();
    const body = multipart([], [{ field: "image", filename: "haute.png", content: tall, type: "image/png" }]);
    const res = await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/thumbnail`, headers: { ...hub.headers, ...body.headers }, payload: body.payload });
    const before = res.json() as SiteDetail;
    const meta = await sharp((await hub.app.inject({ method: "GET", url: before.thumbnailUrl!, headers: hub.headers })).rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([480, 960]);
    const put = (focus: unknown) => hub.app.inject({ method: "PUT", url: `/api/sites/${siteId}/thumbnail/focus`, headers: hub.headers, payload: { focus } });
    const ok = await put("centre");
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as SiteDetail).thumbnailFocus).toBe("centre");
    // Même image, même adresse : seul l'affichage change.
    expect((ok.json() as SiteDetail).thumbnailUrl).toBe(before.thumbnailUrl);
    expect((await put("milieu")).statusCode).toBe(400);
    expect((await put("bas-droite")).statusCode).toBe(200);
    expect(await prisma.auditEvent.count({ where: { action: "thumbnail.focus" } })).toBe(2);
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

describe("capture : même lancement que la mesure de vitesse (lib/chromium.ts)", () => {
  /** Site publié, capture automatique coupée dans le hub (Chromium absent) : le test la lance lui-même. */
  async function published() {
    const { hub, siteId } = await setup(null);
    await uploadFiles(hub, siteId, [{ filename: "index.html", content: '<!doctype html><body style="margin:0;background:#cc3300"><h1>Alpha</h1></body>' }]);
    await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/publish`, headers: hub.headers, payload: {} });
    await settle(hub);
    await hub.services.thumbnails.idle();
    return { hub, siteId, dataDir: hub.services.dataDir, blobs: new BlobStore(hub.services.dataDir) };
  }

  it("production sans utilisateur dédié : capture indisponible, avec la raison", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouzia-hub-thumb-"));
    const svc = new ThumbnailService({ dataDir, blobs: new BlobStore(dataDir), chromiumPath: process.execPath, production: true, chromiumUser: null });
    expect(await svc.captureStatus()).toEqual({ available: false, reason: expect.stringMatching(/^Capture des vignettes désactivée : .*HUB_CHROMIUM_USER/) });
    expect(await svc.captureAvailable()).toBe(false);
    const withUser = new ThumbnailService({ dataDir, blobs: new BlobStore(dataDir), chromiumPath: process.execPath, production: true, chromiumUser: "kouziahub-chromium" });
    expect(await withUser.captureStatus()).toEqual({ available: true, reason: null });
  });

  it("faux lanceur : pipe puis port en échec, capture impossible, raison affichée, repli sur l'image envoyée", async () => {
    const { siteId, dataDir, blobs } = await published();
    const launches: Array<boolean | undefined> = [];
    const spawned: string[][] = [];
    const svc = new ThumbnailService({
      dataDir,
      blobs,
      chromiumPath: process.execPath,
      start: {
        launch: async (o) => {
          launches.push(o.chromiumSandbox);
          throw new Error("Failed to connect to the browser (pipe)");
        },
        spawnBrowser: (_exe, args) => {
          spawned.push(args);
          return spawn(process.execPath, ["-e", "process.stderr.write('doas: refus\n'); process.exit(1)"], { stdio: ["ignore", "ignore", "pipe"] });
        },
      },
    });
    expect(await svc.capture(siteId)).toBe(false);
    expect(launches).toEqual([true]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toContain("--remote-debugging-port=0");
    expect(spawned[0]).toContain("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1");
    expect(spawned[0]!.some((a) => /no-sandbox/.test(a))).toBe(false);
    expect(await svc.captureStatus()).toEqual({ available: false, reason: expect.stringMatching(/bac à sable \(pipe : Failed to connect.*port : lanceur arrêté/) });
    expect((await prisma.site.findUniqueOrThrow({ where: { id: siteId } })).thumbnailPath).toBeNull();
  });

  it("serveur éphémère sur un port choisi par le système (listen(0)), en 127.0.0.1", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouzia-hub-thumb-"));
    const svc = new ThumbnailService({ dataDir, blobs: new BlobStore(dataDir), chromiumPath: null });
    const [a, b] = await Promise.all([svc.serveVersion(new Map()), svc.serveVersion(new Map())]);
    try {
      const [pa, pb] = [a.address() as AddressInfo, b.address() as AddressInfo];
      expect([pa.address, pb.address]).toEqual(["127.0.0.1", "127.0.0.1"]);
      expect(pa.port).not.toBe(pb.port);
      expect(Math.min(pa.port, pb.port)).toBeGreaterThan(1023);
    } finally {
      a.close();
      b.close();
    }
  });

  describe.skipIf(!chromium)("Chromium local", () => {
    it("capture réelle par pipe", { timeout: 60_000 }, async () => {
      const { siteId, dataDir, blobs } = await published();
      const svc = new ThumbnailService({ dataDir, blobs, chromiumPath: chromium });
      const ok = await svc.capture(siteId);
    expect(ok).toBe(true);
      expect(svc.lastVia).toBe("pipe");
      expect(await svc.captureStatus()).toEqual({ available: true, reason: null });
    });

    it("capture réelle par port forcé (pipe refusé comme par doas), connexion CDP en 127.0.0.1", { timeout: 60_000 }, async () => {
      const { siteId, dataDir, blobs } = await published();
      const svc = new ThumbnailService({
        dataDir,
        blobs,
        chromiumPath: chromium,
        start: {
          launch: async () => {
            throw new Error("pipe fermé par le lanceur");
          },
        },
      });
      const ok = await svc.capture(siteId);
    expect(ok).toBe(true);
      expect(svc.lastVia).toBe("port");
      const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
      expect(site.thumbnailSource).toBe("capture");
      const { info } = await sharp(join(dataDir, site.thumbnailPath!)).raw().toBuffer({ resolveWithObject: true });
      expect([info.width, info.height]).toEqual([640, 400]);
    });
  });
});

describe("capture ratée : jamais gardée (lot P5, vignette blanche de my-takumi)", () => {
  it("image d'une seule couleur reconnue ; une vraie page ne l'est pas", async () => {
    const white = await sharp({ create: { width: 1280, height: 800, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const page = await sharp(white).composite([{ input: await sharp({ create: { width: 600, height: 120, channels: 3, background: "#222222" } }).png().toBuffer(), top: 80, left: 80 }]).png().toBuffer();
    expect(await isUniform(white)).toBe(true);
    expect(await isUniform(page)).toBe(false);
  });
});

describe.skipIf(!chromium)("capture ratée et sites PHP (Chromium local)", () => {
  const read = async (hub: TestHub, siteId: string) => (await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}`, headers: hub.headers })).json() as SiteDetail;
  const publish = async (hub: TestHub, siteId: string, files: Array<{ filename: string; content: string }>) => {
    await uploadFiles(hub, siteId, files);
    await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/publish`, headers: hub.headers, payload: {} });
    await settle(hub);
    await hub.services.thumbnails.idle();
  };

  it("page blanche, ou sans page d'accueil (404) : pas de vignette, la raison au journal", { timeout: 60_000 }, async () => {
    const { hub, siteId } = await setup(chromium);
    await publish(hub, siteId, [{ filename: "index.html", content: "<!doctype html><html><body style='background:#fff'></body></html>" }]);
    expect((await read(hub, siteId)).thumbnailUrl).toBeNull();
    const blank = await prisma.auditEvent.findFirst({ where: { action: "thumbnail.capture", result: "error" }, orderBy: { at: "desc" } });
    expect(blank?.detail).toContain("page vide");

    await publish(hub, siteId, [{ filename: "a-propos.html", content: "<h1>Sans accueil</h1>" }]);
    await hub.app.inject({ method: "DELETE", url: `/api/sites/${siteId}/files?path=index.html`, headers: hub.headers });
    await hub.services.thumbnails.capture(siteId);
    expect((await read(hub, siteId)).thumbnailUrl).toBeNull();
  });

  it("site PHP : pages lues par l'agent, navigateur toujours sans réseau ; accueil blanc refusé", { timeout: 60_000 }, async () => {
    const { hub, siteId } = await setup(chromium);
    await publish(hub, siteId, [{ filename: "index.html", content: "<h1>x</h1>" }, { filename: "public/index.php", content: "<?php echo 'x';" }]);
    await prisma.site.update({ where: { id: siteId }, data: { hosting: "php", pagesProject: null } });
    const asked: string[] = [];
    let home = '<!doctype html><link rel="stylesheet" href="/style.css"><img src="https://cdn.exemple/x.png" alt=""><h1>Boutique</h1>';
    const pages = {
      page: async (slug: string, path: string) => {
        asked.push(`${slug} ${path}`);
        if (path === "/") return { status: 200, contentType: "text/html; charset=utf-8", location: null, body: Buffer.from(home) };
        if (path === "/style.css") return { status: 200, contentType: "text/css", location: null, body: Buffer.from("body{background:#1f6f3f;margin:0}") };
        return { status: 404, contentType: "text/plain", location: null, body: Buffer.from("404") };
      },
    };
    const dataDir = hub.services.dataDir;
    const svc = new ThumbnailService({ dataDir, blobs: hub.services.blobs, chromiumPath: chromium, sitesDomain: "kouzia.com", phpPages: () => pages });
    const ok = await svc.capture(siteId);
    expect(ok).toBe(true);
    expect(asked).toEqual(expect.arrayContaining(["alpha /", "alpha /style.css"]));
    // Ressource extérieure arrêtée (CSP puis interception) : jamais demandée à personne.
    expect(asked.some((a) => a.includes("cdn"))).toBe(false);
    const img = await hub.app.inject({ method: "GET", url: (await read(hub, siteId)).thumbnailUrl!, headers: hub.headers });
    const { data, info } = await sharp(img.rawPayload).raw().toBuffer({ resolveWithObject: true });
    const at = (info.width * 300 + 500) * info.channels;
    expect([data[at]! < 80, data[at + 1]! > 80, data[at + 2]! < 100]).toEqual([true, true, true]);

    // Accueil blanc (erreur PHP sans affichage) : la vignette d'avant reste, rien de blanc n'est gardé.
    const before = (await read(hub, siteId)).thumbnailUrl;
    home = "<!doctype html><html><body></body></html>";
    expect(await svc.capture(siteId)).toBe(false);
    expect((await read(hub, siteId)).thumbnailUrl).toBe(before);
    // Sans agent PHP : capture impossible, sans erreur.
    expect(await new ThumbnailService({ dataDir, blobs: hub.services.blobs, chromiumPath: chromium, phpPages: () => null }).capture(siteId)).toBe(false);
  });
});
