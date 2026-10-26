import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { PHP_LIMITS, type PhpCronView, type PhpLogView, type PhpDbView, type PhpEnvView, type PhpScriptRun, type PhpScriptsView, type SiteDetail } from "@/contract.js";
import { audit } from "@/lib/audit.js";
import { requireAuth } from "@/lib/auth.js";
import { HttpError } from "@/lib/http.js";
import { idParams } from "@/lib/http-input.js";
import { dbView, envView, excludedWorkingFiles, nightlyDumps, parseExcludedPaths, phpDumpsDir, phpSite, saveEnv, saveExclusions, scriptsOf, viaAgent } from "@/lib/php-app.js";
import { agentOf, linesOf, phpSettingsFor, specOf } from "@/lib/php-sites.js";
import { prisma } from "@/lib/prisma.js";
import type { Services } from "@/lib/services.js";
import { siteDetail } from "@/lib/site-view.js";
import { checkCron, OpError } from "../../../../scripts/php-ct/agent/sites.mjs";

// Routes d'un site PHP, lot P4 (docs/cadrage.md, 11.5) : réglages après création, variables, base, scripts.

/** Taille maximale d'un fichier SQL importé (compressé ou non). */
export const MAX_SQL_IMPORT_BYTES = 1024 * 1024 * 1024;

const dirList = z.array(z.string().max(200)).max(10);
const settingsSchema = z
  .object({
    version: z.string().max(10).optional(),
    publicDir: z.string().max(200).optional(),
    persistentDirs: dirList.optional(),
    publicPersistentDirs: dirList.optional(),
    memoryLimitMb: z.number().int().min(PHP_LIMITS.memoryLimitMb.min).max(PHP_LIMITS.memoryLimitMb.max).optional(),
    uploadMaxMb: z.number().int().min(PHP_LIMITS.uploadMaxMb.min).max(PHP_LIMITS.uploadMaxMb.max).optional(),
    maxExecutionSec: z.number().int().min(PHP_LIMITS.maxExecutionSec.min).max(PHP_LIMITS.maxExecutionSec.max).optional(),
    excludedPaths: z.array(z.string().max(300)).max(60).optional(),
    cron: z.object({ script: z.string().max(200), every: z.string().max(4) }).strict().nullable().optional(),
  })
  .strict();
const logKinds = z.enum(["php", "fpm", "nginx", "cron"]);
const linesQuery = z.object({ lignes: z.coerce.number().int().min(1).max(2000).optional() });
const exclusionSchema = z.object({ path: z.string().min(1).max(300) }).strict();
const envSchema = z.object({ vars: z.array(z.object({ name: z.string().max(64), value: z.string().max(4096) }).strict()).max(100) }).strict();
const confirmSchema = z.object({ confirm: z.string().max(64) }).strict();
const restoreSchema = z.object({ version: z.number().int().positive(), confirm: z.string().max(64) }).strict();
const nightlySchema = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), confirm: z.string().max(64) }).strict();
const scriptSchema = z
  .object({ path: z.string().min(1).max(200), args: z.array(z.string().max(200)).max(20).optional(), stdin: z.string().max(4096).optional() })
  .strict();

function badRequest(error: z.ZodError): HttpError {
  const first = error.issues[0];
  return new HttpError(400, first?.message && !first.message.startsWith("Invalid") ? first.message : "Données invalides.");
}

/** Double confirmation des opérations qui effacent la base : le sous-domaine retapé. */
function confirmed(slug: string, value: string): void {
  if (value.trim().toLowerCase() !== slug) throw new HttpError(400, `Pour confirmer, taper le sous-domaine « ${slug} ».`, "confirm");
}

export function phpSiteRoutes(services: Services): FastifyPluginAsync {
  return async (app) => {
    app.addHook("onRequest", requireAuth);
    // Import SQL : corps lu en flux (jamais en mémoire), plafonné à MAX_SQL_IMPORT_BYTES.
    app.addContentTypeParser(["application/sql", "application/gzip"], (_req, payload, done) => done(null, payload));

    app.patch("/api/sites/:id/php", async (request): Promise<SiteDetail> => {
      const { id } = idParams.parse(request.params);
      const parsed = settingsSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest(parsed.error);
      const site = await phpSite(id);
      const current = (await siteDetail(id, services)).php!;
      const exclude = parsed.data.excludedPaths !== undefined ? parseExcludedPaths(parsed.data.excludedPaths) : null;
      // Tâche planifiée : règle de l'agent (script relatif .php, sans « .. », fréquence de la liste fermée).
      let cron: { script: string; every: string } | null | undefined;
      try {
        cron = parsed.data.cron === undefined ? undefined : parsed.data.cron === null ? null : checkCron(parsed.data.cron);
      } catch (err) {
        if (err instanceof OpError) throw new HttpError(400, err.message, "php_cron");
        throw err;
      }
      const { cron: _cron, ...settings } = parsed.data;
      const spec = await phpSettingsFor(services, site.slug, { ...current, ...settings, cron: undefined });
      const data = {
        phpVersion: spec.php,
        phpPublicDir: spec.publicDir,
        phpPersistentDirs: spec.persistentDirs.join("\n") || null,
        phpPublicPersistentDirs: spec.publicPersistentDirs.join("\n") || null,
        phpMemoryLimitMb: spec.memoryLimitMb,
        phpUploadMaxMb: spec.uploadMaxMb,
        phpMaxExecutionSec: spec.maxExecutionSec,
        ...(cron !== undefined ? { phpCronScript: cron?.script ?? null, phpCronEvery: cron?.every ?? null } : {}),
      };
      // Posés sur le CT d'abord : en cas de refus, le hub garde les réglages qui y tournent.
      await viaAgent(() => agentOf(services).upsertSite(specOf({ ...site, ...data }, services.sitesDomain)));
      await prisma.site.update({ where: { id }, data });
      // Chemins jamais envoyés : enregistrés, et retirés des fichiers de travail (du hub, jamais du PC).
      if (exclude) await saveExclusions(site, exclude);
      await audit({
        action: "site.php.settings",
        result: "ok",
        siteId: id,
        siteSlug: site.slug,
        detail: `PHP ${spec.php}, ${spec.memoryLimitMb} Mo par requête, envoi ${spec.uploadMaxMb} Mo, ${spec.maxExecutionSec} s`,
      });
      return siteDetail(id, services);
    });

    // Bouton « Ne plus envoyer ce dossier » : aperçu (fichiers et taille retirés du hub), puis ajout confirmé.
    app.get("/api/sites/:id/php/exclusions/apercu", async (request): Promise<{ path: string; count: number; bytes: number }> => {
      const { id } = idParams.parse(request.params);
      const parsed = exclusionSchema.safeParse(request.query);
      if (!parsed.success) throw badRequest(parsed.error);
      const site = await phpSite(id);
      const [path] = parseExcludedPaths([parsed.data.path]);
      const hit = await excludedWorkingFiles(site.id, [path!]);
      return { path: path!, count: hit.paths.length, bytes: hit.bytes };
    });

    app.post("/api/sites/:id/php/exclusions", async (request): Promise<{ excludedPaths: string[]; removed: number; bytes: number }> => {
      const { id } = idParams.parse(request.params);
      const parsed = exclusionSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest(parsed.error);
      const site = await phpSite(id);
      const exclude = parseExcludedPaths([...linesOf(site.phpExcludedPaths), parsed.data.path]);
      const done = await saveExclusions(site, exclude);
      return { excludedPaths: exclude, ...done };
    });

    // --- Tâche planifiée et journaux (lot P5) ---

    app.get("/api/sites/:id/php/cron", async (request): Promise<PhpCronView> => {
      const { id } = idParams.parse(request.params);
      const site = await phpSite(id);
      const r = await viaAgent(() => agentOf(services).cronState(site.slug));
      return { cron: r.cron, active: r.active, maxSec: r.maxSec, last: r.last, output: r.output };
    });

    app.get("/api/sites/:id/php/journaux/:kind", async (request): Promise<PhpLogView> => {
      const { id } = idParams.parse(request.params);
      const kind = logKinds.safeParse((request.params as { kind?: string }).kind);
      if (!kind.success) throw new HttpError(404, "Journal inconnu : php, fpm, nginx ou cron.");
      const q = linesQuery.safeParse(request.query);
      if (!q.success) throw badRequest(q.error);
      const site = await phpSite(id);
      return viaAgent(() => agentOf(services).logs(site.slug, kind.data, q.data.lignes ?? 200));
    });

    // --- Variables ---

    app.get("/api/sites/:id/php/variables", async (request): Promise<PhpEnvView> => {
      const { id } = idParams.parse(request.params);
      return envView(services, await phpSite(id));
    });

    app.put("/api/sites/:id/php/variables", async (request): Promise<PhpEnvView> => {
      const { id } = idParams.parse(request.params);
      const parsed = envSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest(parsed.error);
      return saveEnv(services, await phpSite(id), parsed.data.vars);
    });

    // --- Base ---

    app.get("/api/sites/:id/php/base", async (request): Promise<PhpDbView & { nightly: Array<{ day: string; bytes: number }> }> => {
      const { id } = idParams.parse(request.params);
      const site = await phpSite(id);
      const state = await viaAgent(() => agentOf(services).dbState(site.slug));
      return { ...dbView(state), nightly: await nightlyDumps(services, site.slug) };
    });

    app.post("/api/sites/:id/php/base", async (request): Promise<PhpDbView> => {
      const { id } = idParams.parse(request.params);
      const site = await phpSite(id);
      const state = await viaAgent(() => agentOf(services).createDb(site.slug));
      await audit({ action: "site.php.db.create", result: "ok", siteId: id, siteSlug: site.slug, detail: state.name ?? undefined });
      return dbView(state);
    });

    app.put("/api/sites/:id/php/base/import", { bodyLimit: MAX_SQL_IMPORT_BYTES }, async (request): Promise<PhpDbView> => {
      const { id } = idParams.parse(request.params);
      const site = await phpSite(id);
      const gz = request.headers["content-type"] === "application/gzip";
      if (!(request.body instanceof Object) || typeof (request.body as NodeJS.ReadableStream).pipe !== "function") {
        throw new HttpError(415, "Fichier SQL attendu (.sql ou .sql.gz).");
      }
      const dir = path.join(services.dataDir, "tmp");
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `import-${site.id}-${randomBytes(6).toString("hex")}.${gz ? "sql.gz" : "sql"}`);
      const hash = createHash("sha256");
      let size = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, done) {
          size += chunk.length;
          if (size > MAX_SQL_IMPORT_BYTES) return done(new HttpError(413, "Fichier SQL trop lourd (1 Go au plus)."));
          hash.update(chunk);
          done(null, chunk);
        },
      });
      try {
        await pipeline(request.body as NodeJS.ReadableStream, meter, createWriteStream(file, { mode: 0o600 }));
        if (size === 0) throw new HttpError(400, "Fichier SQL vide.");
        const state = await viaAgent(() => agentOf(services).importDb(site.slug, { file, sha256: hash.digest("hex") }, gz));
        await audit({ action: "site.php.db.import", result: "ok", siteId: id, siteSlug: site.slug, detail: `${Math.round(size / 1024)} Kio${gz ? ", compressé" : ""}` });
        return dbView(state);
      } catch (err) {
        await audit({ action: "site.php.db.import", result: "error", siteId: id, siteSlug: site.slug, detail: err instanceof Error ? err.message : "échec" });
        throw err;
      } finally {
        await rm(file, { force: true });
      }
    });

    app.get("/api/sites/:id/php/base/export", async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const site = await phpSite(id);
      const dir = path.join(services.dataDir, "tmp");
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `export-${site.id}-${randomBytes(6).toString("hex")}.sql.gz`);
      await viaAgent(() => agentOf(services).exportDb(site.slug, file));
      await audit({ action: "site.php.db.export", result: "ok", siteId: id, siteSlug: site.slug });
      const stream = createReadStream(file);
      stream.once("close", () => void rm(file, { force: true }));
      const day = new Date().toISOString().slice(0, 10);
      return reply
        .header("Content-Type", "application/gzip")
        .header("Content-Disposition", `attachment; filename="${site.slug}-base-${day}.sql.gz"`)
        .header("Cache-Control", "private, no-store")
        .send(stream);
    });

    app.post("/api/sites/:id/php/base/reinitialiser", async (request): Promise<PhpDbView> => {
      const { id } = idParams.parse(request.params);
      const parsed = confirmSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest(parsed.error);
      const site = await phpSite(id);
      confirmed(site.slug, parsed.data.confirm);
      const state = await viaAgent(() => agentOf(services).resetDb(site.slug));
      await audit({ action: "site.php.db.reset", result: "ok", siteId: id, siteSlug: site.slug });
      return dbView(state);
    });

    app.post("/api/sites/:id/php/base/restaurer", async (request): Promise<PhpDbView> => {
      const { id } = idParams.parse(request.params);
      const parsed = restoreSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest(parsed.error);
      const site = await phpSite(id);
      confirmed(site.slug, parsed.data.confirm);
      const state = await viaAgent(() => agentOf(services).restoreDump(site.slug, parsed.data.version));
      await audit({ action: "site.php.db.restore", result: "ok", siteId: id, siteSlug: site.slug, detail: `dump d'avant la version ${parsed.data.version}` });
      return dbView(state);
    });

    // Sauvegarde de nuit (gardée par le hub) : sert aussi après la perte du CT. Base recréée si besoin (nouveau
    // compte et DB_* réécrites par l'agent), vidée, puis le dump importé.
    app.post("/api/sites/:id/php/base/sauvegarde", async (request): Promise<PhpDbView> => {
      const { id } = idParams.parse(request.params);
      const parsed = nightlySchema.safeParse(request.body);
      if (!parsed.success) throw badRequest(parsed.error);
      const site = await phpSite(id);
      confirmed(site.slug, parsed.data.confirm);
      const file = path.join(phpDumpsDir(services, site.slug), `${parsed.data.day}.sql.gz`);
      const sha = await new Promise<string>((resolve, reject) => {
        const h = createHash("sha256");
        createReadStream(file)
          .on("data", (c) => h.update(c))
          .on("end", () => resolve(h.digest("hex")))
          .on("error", () => reject(new HttpError(404, `Pas de sauvegarde du ${parsed.data.day}.`)));
      });
      const agent = agentOf(services);
      await viaAgent(() => agent.createDb(site.slug));
      await viaAgent(() => agent.resetDb(site.slug));
      const state = await viaAgent(() => agent.importDb(site.slug, { file, sha256: sha }, true));
      await audit({ action: "site.php.db.restore", result: "ok", siteId: id, siteSlug: site.slug, detail: `sauvegarde de nuit du ${parsed.data.day}` });
      return dbView(state);
    });

    // --- Scripts du projet ---

    app.get("/api/sites/:id/php/scripts", async (request): Promise<PhpScriptsView> => {
      const { id } = idParams.parse(request.params);
      return scriptsOf(await phpSite(id));
    });

    app.post("/api/sites/:id/php/script", async (request): Promise<PhpScriptRun> => {
      const { id } = idParams.parse(request.params);
      const parsed = scriptSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest(parsed.error);
      const site = await phpSite(id);
      const { scripts } = await scriptsOf(site);
      if (!scripts.includes(parsed.data.path)) throw new HttpError(404, "Script absent de la version servie.", "php_script");
      const r = await viaAgent(() => agentOf(services).runScript(site.slug, parsed.data.path, parsed.data.args ?? [], parsed.data.stdin ?? ""));
      // Journal : le script et son résultat, jamais ses arguments ni son entrée (mots de passe).
      await audit({
        action: "site.php.script",
        result: r.code === 0 ? "ok" : "error",
        siteId: id,
        siteSlug: site.slug,
        detail: `${r.script} : ${r.timedOut ? "délai dépassé" : `code ${r.code}`}, ${Math.round(r.durationMs / 100) / 10} s`,
      });
      return r;
    });
  };
}
