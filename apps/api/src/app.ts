import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { MAX_FILE_BYTES, MAX_FILES_PER_UPLOAD, MAX_PARTS_PER_UPLOAD } from "@/lib/limits.js";
import { accessConfig, getCookieSecure, getTrustedProxies } from "@/lib/env.js";
import { registerClientIpHook, trustProxyFn } from "@/lib/client-ip.js";
import { AccessVerifier, registerAccessGuard } from "@/lib/access.js";
import { pendingMigrationCount } from "@/lib/migration-check.js";
import { originGuardPlugin } from "@/plugins/origin-guard.js";
import { authRoutes } from "@/routes/auth.js";
import { RATE_LIMITED, registerErrorHandler } from "@/lib/http.js";
import { logSerializers } from "@/lib/log-redact.js";
import { registerInputGuards } from "@/lib/http-input.js";
import { createServices, type Services } from "@/lib/services.js";
import { sitesRoutes } from "@/routes/sites.js";
import { filesRoutes } from "@/routes/files.js";
import { uploadsRoutes } from "@/routes/uploads.js";
import { systemRoutes } from "@/routes/system.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Fichier produit par Vite dans /assets, au nom hashé : son contenu ne change jamais. */
const isHashedAsset = (filePath: string) => /[\\/]assets[\\/][^\\/]+$/.test(filePath);

export const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";

export type BuildAppOptions = {
  /** Désactive les logs (tests). Défaut false. */
  silent?: boolean;
  /** Sert le build web statique (prod). Défaut true. */
  serveStatic?: boolean;
  /** Vérificateur Access injecté (tests). Défaut : d'après le .env, null si coupé en dev. */
  accessVerifier?: AccessVerifier | null;
  /** Services métier injectés (tests : Cloudflare et ERP factices en mémoire). Défaut : d'après le .env. */
  services?: Services;
};

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const trustedProxies = getTrustedProxies();
  const app = Fastify({
    logger: opts.silent
      ? false
      : {
          redact: { paths: ["req.headers.authorization", "req.headers.cookie"], censor: "[redacted]" },
          serializers: logSerializers,
        },
    trustProxy: trustProxyFn(trustedProxies),
    // Corps JSON : petits (les fichiers passent en multipart).
    bodyLimit: 1024 * 1024,
  });
  // Avant toute route et toute limite de débit : request.ip doit être l'IP réelle.
  registerClientIpHook(app, trustedProxies);
  const config = accessConfig();
  registerAccessGuard(app, opts.accessVerifier !== undefined ? opts.accessVerifier : config ? new AccessVerifier(config) : null);

  registerErrorHandler(app);

  // En-têtes « HTTPS seulement » (HSTS, COOP) : jamais en HTTP local.
  const webOrigin = (process.env.HUB_PUBLIC_ORIGIN ?? process.env.WEB_ORIGIN ?? "").trim().toLowerCase();
  const httpsMode = webOrigin.startsWith("https://") ? true : webOrigin.startsWith("http://") ? false : getCookieSecure();
  await app.register(helmet, {
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: httpsMode ? { maxAge: 31_536_000, includeSubDomains: false } : false,
    crossOriginOpenerPolicy: httpsMode ? { policy: "same-origin" } : false,
    originAgentCluster: httpsMode,
    frameguard: { action: "deny" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
  });

  await app.register(cookie, { secret: process.env.SESSION_SECRET, parseOptions: {} });

  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) => Object.assign(new Error(RATE_LIMITED), { statusCode: context.statusCode }),
  });

  // Plafonds par fichier : 25 Mio (limite Cloudflare Pages) ; le zip a son propre plafond, posé par sa route.
  // Défauts globaux ; chaque route d'envoi précise les siens (parties, fichiers, taille).
  await app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_UPLOAD, parts: MAX_PARTS_PER_UPLOAD, fields: 50 } });

  await app.register(originGuardPlugin);
  registerInputGuards(app);

  // Réponses de l'API jamais mises en cache (sauf en-tête posé par la route) ; rien d'indexable.
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/") && !reply.hasHeader("cache-control")) reply.header("Cache-Control", "no-store");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
    reply.header("X-Robots-Tag", "noindex, nofollow");
    return payload;
  });

  await app.register(authRoutes);
  const services = opts.services ?? createServices();
  app.addHook("onClose", async () => services.close());
  await app.register(sitesRoutes(services));
  await app.register(filesRoutes(services));
  await app.register(uploadsRoutes(services));
  await app.register(systemRoutes(services));

  app.get("/api/health", async () => ({ ok: true, pendingMigrations: pendingMigrationCount() }));
  app.get("/robots.txt", async (_request, reply) => reply.type("text/plain; charset=utf-8").send(ROBOTS_TXT));

  let spaServed = false;
  if (opts.serveStatic !== false) {
    const webDist = process.env.WEB_DIST ? path.resolve(process.env.WEB_DIST) : path.resolve(__dirname, "../../web/dist");
    const { existsSync } = await import("node:fs");
    if (existsSync(path.join(webDist, "index.html"))) {
      await app.register(fastifyStatic, {
        root: webDist,
        wildcard: false,
        cacheControl: false,
        index: false,
        // Jamais de fichier caché (.env, .git) ni de carte de sources, même si l'un traînait dans dist.
        allowedPath: (pathname) => !/(^|\/)\.|\.map$/.test(pathname) && pathname !== "/index.html",
        setHeaders: (reply, filePath) => {
          reply.header("Cache-Control", isHashedAsset(filePath) ? "public, max-age=31536000, immutable" : "no-cache");
        },
      });
      app.setNotFoundHandler((request, reply) => {
        const pathname = request.url.split("?")[0]!;
        // Fichier absent (ancien chunk après une mise à jour) : 404, jamais index.html à sa place.
        if (pathname.startsWith("/api/") || pathname.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(pathname)) {
          return reply.code(404).send({ error: "Not found" });
        }
        if (request.method !== "GET" && request.method !== "HEAD") return reply.code(404).send({ error: "Not found" });
        return reply.header("Cache-Control", "no-cache").sendFile("index.html");
      });
      spaServed = true;
    } else {
      app.log.info("Pas de build web : API seule (mode dev)");
    }
  }
  if (!spaServed) app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "Not found" }));

  return app;
}
