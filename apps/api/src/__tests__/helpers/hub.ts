import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import yazl from "yazl";
import { buildApp } from "@/app.js";
import { FakeCloudflare } from "@/lib/cloudflare/fake.js";
import type { CloudflareGateway } from "@/lib/cloudflare/types.js";
import { FakeErpDirectory } from "@/lib/erp/fake.js";
import type { ErpDirectory } from "@/lib/erp/types.js";
import { createServices, type Services, type ServicesOverrides } from "@/lib/services.js";

/** fetch qui refuse tout : garantit qu'aucun test ne sort sur le réseau par mégarde. */
export const refusingFetch = (async (input: string | URL | Request) => {
  throw new Error(`réseau interdit en test : ${String(input)}`);
}) as typeof fetch;
import { prisma } from "@/lib/prisma.js";
import { authed, createAdmin, loginCookie, TEST_EMAIL } from "./auth.js";

export type TestHub = {
  app: FastifyInstance;
  services: Services;
  cf: FakeCloudflare;
  headers: { cookie: string; origin: string };
};

/** App complète sur un Cloudflare et un ERP factices en mémoire, données dans un dossier temporaire. */
export async function buildTestHub(
  opts: {
    cloudflare?: CloudflareGateway;
    erp?: ErpDirectory;
    chromiumPath?: string | null;
    watcherDelaysMs?: number[];
    monitor?: ServicesOverrides["monitor"];
    push?: ServicesOverrides["push"];
    zones?: ServicesOverrides["zones"];
    phpAgent?: ServicesOverrides["phpAgent"];
  } = {},
): Promise<TestHub> {
  const cf = (opts.cloudflare as FakeCloudflare | undefined) ?? new FakeCloudflare();
  const services = createServices({
    cloudflare: cf,
    erp: opts.erp ?? new FakeErpDirectory(),
    dataDir: mkdtempSync(join(tmpdir(), "kouzia-hub-data-")),
    sitesDomain: "kouzia.com",
    domainWatcher: { delaysMs: opts.watcherDelaysMs ?? [20] },
    chromiumPath: opts.chromiumPath === undefined ? null : opts.chromiumPath,
    // Surveillance : aucun réseau, même si un test déclenche un contrôle sans fake dédié.
    monitor: { fetch: refusingFetch, speed: async () => ({ available: false, reason: "test" }), ...opts.monitor },
    ...(opts.push ? { push: opts.push } : {}),
    ...(opts.zones ? { zones: opts.zones } : {}),
    // Serveur des sites PHP : jamais lu depuis l'environnement du poste.
    phpAgent: opts.phpAgent ?? null,
  });
  const app = await buildApp({ silent: true, serveStatic: false, accessVerifier: null, services });
  if (!(await prisma.user.findUnique({ where: { email: TEST_EMAIL } }))) await createAdmin();
  const headers = authed(await loginCookie(app));
  return { app, services, cf, headers };
}

/** Attend la fin des opérations en arrière-plan. */
export const settle = (hub: TestHub) => hub.services.engine.idle();

export async function createPersoSite(hub: TestHub, slug: string, label = `Site ${slug}`): Promise<string> {
  const res = await hub.app.inject({ method: "POST", url: "/api/sites", headers: hub.headers, payload: { kind: "PERSO", slug, label } });
  if (res.statusCode !== 201) throw new Error(`création ${res.statusCode} ${res.body}`);
  await settle(hub);
  return res.json().id as string;
}

/**
 * Envoi de fichiers comme l'interface : session, morceaux, finalisation. Renvoie la réponse de la finalisation
 * (UploadResult), ou celle de l'étape refusée (ouverture ou morceau).
 */
export async function uploadFiles(hub: TestHub, siteId: string, files: Array<{ filename: string; content: Buffer | string }>, dir?: string, mode?: "replace" | "merge") {
  const bufs = files.map((f) => Buffer.from(f.content));
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const open = await hub.app.inject({
    method: "POST",
    url: `/api/sites/${siteId}/uploads`,
    headers: hub.headers,
    payload: { kind: "files", ...(dir !== undefined ? { dir } : {}), ...(mode ? { mode } : {}), files: files.map((f, i) => ({ path: f.filename, size: bufs[i]!.length, sha256: sha(bufs[i]!) })) },
  });
  if (open.statusCode !== 200) return open;
  const session = open.json() as { id: string; included: number[]; chunkSize: number; chunkCount: number };
  const stream = Buffer.concat(session.included.map((i) => bufs[i]!));
  for (let n = 0; n < session.chunkCount; n++) {
    const chunk = stream.subarray(n * session.chunkSize, (n + 1) * session.chunkSize);
    const put = await hub.app.inject({
      method: "PUT",
      url: `/api/sites/${siteId}/uploads/${session.id}/chunks/${n}`,
      headers: { ...hub.headers, "content-type": "application/octet-stream", "x-chunk-sha256": sha(chunk) },
      payload: chunk,
    });
    if (put.statusCode !== 200) return put;
  }
  return hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/uploads/${session.id}/complete`, headers: hub.headers });
}

/** Envoi d'un zip comme l'interface : session zip, morceaux, finalisation (réponse de l'étape refusée sinon). */
export async function uploadZip(hub: TestHub, siteId: string, zip: Buffer, mode: string) {
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const open = await hub.app.inject({
    method: "POST",
    url: `/api/sites/${siteId}/uploads`,
    headers: hub.headers,
    payload: { kind: "zip", mode, name: "site.zip", size: zip.length, sha256: sha(zip) },
  });
  if (open.statusCode !== 200) return open;
  const session = open.json() as { id: string; chunkSize: number; chunkCount: number };
  for (let n = 0; n < session.chunkCount; n++) {
    const chunk = zip.subarray(n * session.chunkSize, (n + 1) * session.chunkSize);
    const put = await hub.app.inject({
      method: "PUT",
      url: `/api/sites/${siteId}/uploads/${session.id}/chunks/${n}`,
      headers: { ...hub.headers, "content-type": "application/octet-stream", "x-chunk-sha256": sha(chunk) },
      payload: chunk,
    });
    if (put.statusCode !== 200) return put;
  }
  return hub.app.inject({ method: "POST", url: `/api/sites/${siteId}/uploads/${session.id}/complete`, headers: hub.headers });
}

export type MultipartFile = { field?: string; filename: string; content: Buffer | string; type?: string };

/** Corps multipart/form-data construit à la main (champs puis fichiers, dans l'ordre donné). */
export function multipart(fields: Array<[string, string]>, files: MultipartFile[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----kouziahub${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of fields) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field ?? "file"}"; filename="${f.filename}"\r\n` +
          `Content-Type: ${f.type ?? "application/octet-stream"}\r\n\r\n`,
      ),
    );
    chunks.push(Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

export type ZipEntry = { name: string; content: Buffer | string; mode?: number; compress?: boolean };

export function makeZip(entries: ZipEntry[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const e of entries) {
      zip.addBuffer(Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content), e.name, {
        compress: e.compress ?? true,
        ...(e.mode !== undefined ? { mode: e.mode } : {}),
      });
    }
    zip.end();
    const parts: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => parts.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(parts)));
    zip.outputStream.on("error", reject);
  });
}

/** Remplace un nom de même longueur partout dans l'archive (en-têtes local et central) : zip piégé. */
export function patchName(zip: Buffer, from: string, to: string): Buffer {
  if (Buffer.byteLength(from) !== Buffer.byteLength(to)) throw new Error("longueurs différentes");
  const out = Buffer.from(zip);
  const needle = Buffer.from(from);
  let i = out.indexOf(needle);
  while (i !== -1) {
    Buffer.from(to).copy(out, i);
    i = out.indexOf(needle, i + needle.length);
  }
  return out;
}

/** Fausse taille décompressée dans les en-têtes local et central : l'en-tête ment sur la taille réelle. */
export function patchUncompressedSize(zip: Buffer, size: number): Buffer {
  const out = Buffer.from(zip);
  for (let i = 0; i < out.length - 4; i++) {
    const sig = out.readUInt32LE(i);
    if (sig === 0x04034b50) out.writeUInt32LE(size, i + 22);
    else if (sig === 0x02014b50) out.writeUInt32LE(size, i + 24);
  }
  return out;
}
