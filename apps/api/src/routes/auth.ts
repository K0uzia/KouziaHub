import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { z } from "zod";
import { prisma } from "@/lib/prisma.js";
import {
  attachUser,
  clearSessionCookie,
  createSession,
  destroySession,
  hashPassword,
  requireAuth,
  setSessionCookie,
  verifyPassword,
} from "@/lib/auth.js";
import { otpauthUri } from "@/lib/admin/totp.js";
import {
  clearFailures,
  closeLoginChallenge,
  confirmEnrollment,
  consumeRecoveryCode,
  consumeTotpCode,
  failLoginChallenge,
  findLoginChallenge,
  isLocked,
  isTwoFactorEnabled,
  openLoginChallenge,
  regenerateRecoveryCodes,
  registerFailure,
  remainingRecoveryCodes,
  startEnrollment,
  strictLogin,
} from "@/lib/admin/two-factor.js";
import { audit } from "@/lib/audit.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(512),
});

const secondFactorSchema = z.union([
  z.object({ code: z.string().trim().regex(/^\d{6}$/) }),
  z.object({ recoveryCode: z.string().trim().min(10).max(20) }),
]);

const codeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/) });

const BAD_CREDENTIALS = { error: "E-mail ou mot de passe incorrect." };
/** Refus de connexion : jamais plus rapide que ce plancher (compte inconnu, verrouillé ou mot de passe faux). */
export const LOGIN_FAILURE_FLOOR_MS = 250;
const floor = async (startedAt: number) => {
  const wait = LOGIN_FAILURE_FLOOR_MS - (Date.now() - startedAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
};
const BAD_CODE = { error: "Code incorrect." };
const CHALLENGE_EXPIRED = { error: "Connexion expirée : saisissez à nouveau votre mot de passe." };
const NEEDS_2FA = {
  error:
    "Connexion impossible tant que la double authentification n'est pas activée. " +
    "Sur le serveur du hub, lancez « hubctl admin » pour l'activer.",
};

// Hash argon2 d'un mot de passe aléatoire : un e-mail inconnu coûte le même temps qu'un mauvais mot de passe.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword(`dummy-${Date.now()}-${Math.random()}`));

async function openSession(user: { id: string; email: string; name: string | null }, request: FastifyRequest, reply: FastifyReply) {
  await prisma.session.deleteMany({ where: { userId: user.id, expiresAt: { lt: new Date() } } });
  // Rotation : la session éventuelle du navigateur est remplacée.
  await attachUser(request);
  if (request.sessionId) await destroySession(request.sessionId);
  const session = await createSession(user.id);
  setSessionCookie(request, reply, session.token, session.expiresAt);
  await clearFailures(user.id);
  await audit({ action: "auth.login", result: "ok" });
  return { user: { id: user.id, email: user.email, name: user.name } };
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const startedAt = Date.now();
    // Même message et même délai minimal pour tout refus : rien sur l'existence du compte ni son état.
    const refuse = async (code: 400 | 401) => {
      await floor(startedAt);
      return reply.code(code).send(BAD_CREDENTIALS);
    };
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return refuse(400);

    const email = parsed.data.email.toLowerCase().trim();
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      await verifyPassword(parsed.data.password, await getDummyHash());
      return refuse(401);
    }
    if (isLocked(user, request)) return refuse(401);

    if (!(await verifyPassword(parsed.data.password, user.passwordHash))) {
      await registerFailure(user.id, request);
      return refuse(401);
    }

    if (isTwoFactorEnabled(user)) {
      await openLoginChallenge(user.id, request, reply);
      return { mfaRequired: true };
    }
    if (strictLogin(request)) return reply.code(403).send(NEEDS_2FA);
    return openSession(user, request, reply);
  });

  app.post("/api/auth/2fa", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const parsed = secondFactorSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Code à 6 chiffres attendu." });

    const challenge = await findLoginChallenge(request);
    if (!challenge) return reply.code(401).send(CHALLENGE_EXPIRED);
    const { user } = challenge;
    if (isLocked(user, request) || !isTwoFactorEnabled(user)) {
      await closeLoginChallenge(user.id, request, reply);
      return reply.code(401).send(CHALLENGE_EXPIRED);
    }

    const ok =
      "code" in parsed.data
        ? await consumeTotpCode(user, parsed.data.code)
        : await consumeRecoveryCode(user.id, parsed.data.recoveryCode);
    if (!ok) {
      await failLoginChallenge(challenge.id);
      await registerFailure(user.id, request);
      return reply.code(401).send(BAD_CODE);
    }

    await closeLoginChallenge(user.id, request, reply);
    return openSession(user, request, reply);
  });

  app.post("/api/auth/logout", { config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } }, async (request, reply) => {
    await requireAuth(request, reply);
    if (request.sessionId) await destroySession(request.sessionId);
    clearSessionCookie(request, reply);
    return { ok: true };
  });

  app.get("/api/auth/me", async (request) => {
    await attachUser(request);
    return { user: request.user ?? null };
  });

  // --- Réglages > Sécurité ---

  app.get("/api/auth/2fa/status", async (request, reply) => {
    await requireAuth(request, reply);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.id } });
    return {
      enabled: isTwoFactorEnabled(user),
      enabledAt: user.totpEnabledAt,
      recoveryCodesRemaining: isTwoFactorEnabled(user) ? await remainingRecoveryCodes(user.id) : 0,
    };
  });

  app.post("/api/auth/2fa/setup", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    await requireAuth(request, reply);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.id } });
    if (isTwoFactorEnabled(user)) {
      return reply.code(409).send({ error: "La double authentification est déjà activée." });
    }
    const secret = await startEnrollment(user.id);
    const uri = otpauthUri(secret, user.email, "Kouzia Hub");
    const qrSvg = await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return { secret, otpauthUri: uri, qrSvg };
  });

  app.post("/api/auth/2fa/enable", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    await requireAuth(request, reply);
    const parsed = codeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Code à 6 chiffres attendu." });
    const userId = request.user!.id;
    const recoveryCodes = await confirmEnrollment(userId, parsed.data.code);
    if (!recoveryCodes) return reply.code(400).send(BAD_CODE);
    // Les autres sessions ont été ouvertes sans second facteur : elles sont fermées.
    await prisma.session.deleteMany({
      where: { userId, ...(request.sessionId ? { id: { not: request.sessionId } } : {}) },
    });
    return { recoveryCodes };
  });

  app.post(
    "/api/auth/2fa/recovery-codes",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      await requireAuth(request, reply);
      const parsed = codeSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Code à 6 chiffres attendu." });
      const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.id } });
      if (!isTwoFactorEnabled(user)) {
        return reply.code(409).send({ error: "La double authentification n'est pas activée." });
      }
      if (!(await consumeTotpCode(user, parsed.data.code))) return reply.code(400).send(BAD_CODE);
      return { recoveryCodes: await regenerateRecoveryCodes(user.id) };
    },
  );
};
