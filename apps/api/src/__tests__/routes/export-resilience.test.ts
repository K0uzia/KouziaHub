import { rmSync, truncateSync, utimesSync, existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HubCachePurgeResult } from "@/contract.js";
import { prisma, resetDb } from "../helpers/db.js";
import { buildTestHub, createPersoSite, multipart, settle, type TestHub } from "../helpers/hub.js";

let hub: TestHub;
let siteId: string;
let base: string;

beforeEach(async () => {
  await resetDb();
  hub = await buildTestHub();
  siteId = await createPersoSite(hub, "alpha");
  await hub.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(hub.app.server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await hub.app.close();
});

async function publishSite(extra: Array<{ filename: string; content: Buffer | string }> = []) {
  const body = multipart([], [{ field: "files", filename: "index.html", content: "<h1>x</h1>" }, ...extra.map((f) => ({ field: "files", ...f }))]);
  await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/files`, headers: { ...hub.headers, ...body.headers }, payload: body.payload });
  await hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/publish`, headers: hub.headers, payload: {} });
  await settle(hub);
}

/** Lit la réponse jusqu'au bout ; renvoie l'erreur de lecture éventuelle (flux coupé). */
async function download(path: string): Promise<{ status: number; error: unknown; bytes: number }> {
  const res = await fetch(base + path, { headers: hub.headers });
  let error: unknown = null;
  let bytes = 0;
  try {
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
    }
  } catch (err) {
    error = err;
  }
  return { status: res.status, error, bytes };
}

async function healthy() {
  const res = await fetch(`${base}/api/health`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
}

describe("export de production : robustesse (P1-1)", () => {
  it("blob supprimé en plein flux : réponse coupée, API debout, verrou rendu", async () => {
    await publishSite([{ filename: "gros.bin", content: Buffer.alloc(3 * 1024 * 1024, 7) }]);
    const big = await prisma.versionFile.findFirstOrThrow({ where: { path: "gros.bin" } });
    const original = hub.services.blobs.stream.bind(hub.services.blobs);
    hub.services.blobs.stream = (sha) => {
      if (sha === big.sha256) rmSync(hub.services.blobs.pathOf(sha), { force: true });
      return original(sha);
    };
    const r = await download(`/api/sites/${siteId}/export`);
    expect(r.error !== null || r.status !== 200).toBe(true);
    await healthy();
    hub.services.blobs.stream = original;
    // Verrou rendu : l'export suivant répond (409 clair : le fichier manque désormais).
    const again = await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/export`, headers: hub.headers });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "export_blob_missing" });
    // Journal écrit en arrière-plan par l'écouteur d'erreur : attendu un court instant.
    let logged = null;
    for (let i = 0; i < 50 && !logged; i++) {
      logged = await prisma.auditEvent.findFirst({ where: { action: "version.export", result: "error" } });
      if (!logged) await new Promise((r) => setTimeout(r, 20));
    }
    expect(logged).not.toBeNull();
  });

  it("blob tronqué en plein flux (taille inattendue pour yazl) : réponse coupée, API debout", async () => {
    await publishSite([{ filename: "gros.bin", content: Buffer.alloc(2 * 1024 * 1024, 3) }]);
    const big = await prisma.versionFile.findFirstOrThrow({ where: { path: "gros.bin" } });
    const original = hub.services.blobs.stream.bind(hub.services.blobs);
    hub.services.blobs.stream = (sha) => {
      if (sha === big.sha256) truncateSync(hub.services.blobs.pathOf(sha), 1000);
      return original(sha);
    };
    const r = await download(`/api/sites/${siteId}/export`);
    expect(r.error !== null || r.status !== 200).toBe(true);
    await healthy();
  });

  it("blob absent avant l'envoi : 409 JSON clair, rien d'envoyé", async () => {
    await publishSite();
    const index = await prisma.versionFile.findFirstOrThrow({ where: { path: "index.html", version: { source: "files" } } });
    rmSync(hub.services.blobs.pathOf(index.sha256), { force: true });
    const res = await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/export`, headers: hub.headers });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/index\.html/);
  });

  it("export refusé pendant qu'une autre action tient le verrou du site", async () => {
    await publishSite();
    const release = await hub.services.engine.acquire(siteId);
    try {
      const res = await hub.app.inject({ method: "GET", url: `/api/sites/${siteId}/export`, headers: hub.headers });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("operation_running");
    } finally {
      release();
    }
  });
});

describe("purge des orphelins et envois en cours (P1-2)", () => {
  it("les blobs d'un envoi en cours ne sont jamais purgés, même vieux et sans ligne", async () => {
    const blobs = hub.services.blobs;
    blobs.recentGraceMs = 0;
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const shas: string[] = [];
    // Envoi long : blobs rangés, lignes pas encore écrites.
    const upload = blobs.withPins(async () => {
      for (let i = 0; i < 5; i++) shas.push((await blobs.putBuffer(Buffer.from(`morceau-${i}-${"x".repeat(1000)}`))).sha256);
      const old = new Date(Date.now() - 3_600_000);
      for (const sha of shas) utimesSync(blobs.pathOf(sha), old, old);
      await gate;
    });
    await new Promise((r) => setTimeout(r, 20));
    const res = await hub.app.inject({ method: "POST", url: "/api/storage/purge", headers: hub.headers, payload: { orphans: true } });
    expect((res.json() as HubCachePurgeResult).orphans?.count).toBe(0);
    expect(await blobs.releaseUnused(shas)).toEqual({ count: 0, bytes: 0 });
    for (const sha of shas) expect(existsSync(blobs.pathOf(sha))).toBe(true);
    finish();
    await upload;
    // Envoi abandonné sans lignes : les blobs redeviennent des orphelins ordinaires.
    const after = await hub.app.inject({ method: "POST", url: "/api/storage/purge", headers: hub.headers, payload: { orphans: true } });
    expect((after.json() as HubCachePurgeResult).orphans?.count).toBeGreaterThanOrEqual(5);
  });

  it("délai de grâce par défaut : 10 minutes au moins", () => {
    expect(hub.services.blobs.recentGraceMs).toBeGreaterThanOrEqual(10 * 60_000);
  });
});
