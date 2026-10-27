import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { User } from "@prisma/client";
import { audit } from "@/lib/audit.js";
import { prisma } from "@/lib/prisma.js";
import { decrypt, encrypt, encryptionKey, subKey } from "@/lib/crypto.js";
import { getCookieSecure } from "@/lib/env.js";
import { generateTotpSecret, matchTotpStep } from "@/lib/admin/totp.js";

export const CHALLENGE_COOKIE = "kz_hub_mfa";
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const CHALLENGE_MAX_ATTEMPTS = 5;
/** Échecs consécutifs (connexion stricte) avant verrouillage temporaire du compte. */
export const LOCK_AFTER_FAILURES = 5;
/**
 * Verrouillage progressif, sans filtre en amont du tunnel (pas de Cloudflare Access) : 15 min, puis 1 h,
 * 4 h et 24 h selon le nombre de verrouillages des dernières 24 h (journal, action auth.lock).
 */
export const LOCK_STEPS_MS = [15 * 60_000, 3_600_000, 4 * 3_600_000, 24 * 3_600_000] as const;
export const RECOVERY_CODE_COUNT = 10;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function isTwoFactorEnabled(user: Pick<User, "totpSecretEncrypted" | "totpEnabledAt">): boolean {
  return Boolean(user.totpSecretEncrypted && user.totpEnabledAt);
}

/**
 * Connexion « stricte » : double authentification exigée et échecs comptés. Toute requête en production,
 * quelle que soit sa provenance (un TRUST_PROXY mal réglé ne doit pas laisser passer le tunnel sans 2FA) ;
 * en dev, seulement les requêtes reconnues comme venant du tunnel. La console du CT (hubctl, sans HTTP)
 * reste le recours en cas de verrouillage.
 */
export function strictLogin(request: FastifyRequest): boolean {
  return request.viaTunnel || process.env.NODE_ENV === "production";
}

// --- Verrouillage (connexions strictes : la console du CT reste un recours) ---

export function isLocked(user: Pick<User, "lockedUntil">, request: FastifyRequest): boolean {
  return strictLogin(request) && !!user.lockedUntil && user.lockedUntil.getTime() > Date.now();
}

export async function registerFailure(userId: string, request: FastifyRequest): Promise<void> {
  if (!strictLogin(request)) return;
  const user = await prisma.user.update({ where: { id: userId }, data: { failedLogins: { increment: 1 } } });
  if (user.failedLogins >= LOCK_AFTER_FAILURES) {
    const recent = await prisma.auditEvent.count({ where: { action: "auth.lock", at: { gte: new Date(Date.now() - 86_400_000) } } });
    const duration = LOCK_STEPS_MS[Math.min(recent, LOCK_STEPS_MS.length - 1)]!;
    await prisma.user.update({
      where: { id: userId },
      data: { failedLogins: 0, lockedUntil: new Date(Date.now() + duration) },
    });
    await audit({ action: "auth.lock", result: "error", detail: `compte verrouillé ${formatLock(duration)} après ${LOCK_AFTER_FAILURES} échecs (IP ${request.ip})` });
  }
}

const formatLock = (ms: number) => (ms < 3_600_000 ? `${ms / 60_000} min` : `${ms / 3_600_000} h`);

export async function clearFailures(userId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { failedLogins: 0, lockedUntil: null } });
}

// --- Étape intermédiaire : mot de passe validé, code attendu ---

function cookieBase(request: FastifyRequest) {
  return {
    path: "/api/auth",
    httpOnly: true,
    sameSite: "strict" as const,
    secure: getCookieSecure() || request.viaTunnel,
  };
}

export async function openLoginChallenge(userId: string, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  await prisma.adminLoginChallenge.deleteMany({ where: { OR: [{ userId }, { expiresAt: { lt: new Date() } }] } });
  await prisma.adminLoginChallenge.create({
    data: {
      id: sha256(token),
      userId,
      expiresAt,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
    },
  });
  reply.setCookie(CHALLENGE_COOKIE, token, { ...cookieBase(request), expires: expiresAt });
}

export async function findLoginChallenge(request: FastifyRequest) {
  const token = request.cookies[CHALLENGE_COOKIE];
  if (!token) return null;
  const challenge = await prisma.adminLoginChallenge.findUnique({ where: { id: sha256(token) }, include: { user: true } });
  if (!challenge) return null;
  if (challenge.expiresAt.getTime() < Date.now() || challenge.attempts >= CHALLENGE_MAX_ATTEMPTS) {
    await prisma.adminLoginChallenge.delete({ where: { id: challenge.id } }).catch(() => undefined);
    return null;
  }
  return challenge;
}

/**
 * Réserve un essai AVANT de vérifier le code : écriture conditionnelle atomique (SQLite sérialise les écritures). Des
 * requêtes lancées en parallèle ne peuvent pas évaluer plus de CHALLENGE_MAX_ATTEMPTS codes (audit du 27/10/2026).
 */
export async function reserveChallengeAttempt(challengeId: string): Promise<boolean> {
  const { count } = await prisma.adminLoginChallenge.updateMany({
    where: { id: challengeId, attempts: { lt: CHALLENGE_MAX_ATTEMPTS }, expiresAt: { gt: new Date() } },
    data: { attempts: { increment: 1 } },
  });
  return count === 1;
}

/** Échec sur un challenge (essai déjà compté par reserveChallengeAttempt) : supprimé au dernier essai. */
export async function failLoginChallenge(challengeId: string): Promise<void> {
  const c = await prisma.adminLoginChallenge.findUnique({ where: { id: challengeId } });
  if (c && c.attempts >= CHALLENGE_MAX_ATTEMPTS) {
    await prisma.adminLoginChallenge.delete({ where: { id: c.id } }).catch(() => undefined);
  }
}

export async function closeLoginChallenge(userId: string, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await prisma.adminLoginChallenge.deleteMany({ where: { userId } });
  reply.clearCookie(CHALLENGE_COOKIE, cookieBase(request));
}

// --- Vérification du second facteur ---

/**
 * Code TOTP valide et jamais utilisé : le pas est enregistré en une seule écriture conditionnelle,
 * donc deux requêtes simultanées avec le même code ne passent pas toutes les deux.
 */
export async function consumeTotpCode(user: Pick<User, "id" | "totpSecretEncrypted">, code: string): Promise<boolean> {
  if (!user.totpSecretEncrypted) return false;
  const step = matchTotpStep(decrypt(user.totpSecretEncrypted), code);
  if (step === null) return false;
  const { count } = await prisma.user.updateMany({
    where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
    data: { totpLastStep: step },
  });
  return count === 1;
}

const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Empreinte d'un code de secours : HMAC avec une sous-clé dédiée (HKDF), jamais la clé de chiffrement elle-même. */
export function hashRecoveryCode(code: string): string {
  return createHmac("sha256", subKey("codes-de-secours")).update(normalizeRecoveryCode(code)).digest("hex");
}

/** Ancien format (HMAC avec la clé de chiffrement) : accepté, puis réécrit au nouveau quand le code sert. */
export function legacyRecoveryHash(code: string): string {
  return createHmac("sha256", encryptionKey()).update(normalizeRecoveryCode(code)).digest("hex");
}

/** Remplace tous les codes de secours : 10 codes « XXXXX-XXXXX » (50 bits chacun), affichés une seule fois. */
export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join("");
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  await prisma.$transaction([
    prisma.adminRecoveryCode.deleteMany({ where: { userId } }),
    prisma.adminRecoveryCode.createMany({ data: codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })) }),
  ]);
  return codes;
}

export async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  if (normalizeRecoveryCode(code).length !== 10) return false;
  const { count } = await prisma.adminRecoveryCode.updateMany({
    where: { userId, codeHash: hashRecoveryCode(code), usedAt: null },
    data: { usedAt: new Date() },
  });
  if (count === 1) return true;
  // Code émis avant la sous-clé : vérifié à l'ancien format, puis réécrit au nouveau en même temps qu'il est utilisé.
  const legacy = await prisma.adminRecoveryCode.updateMany({
    where: { userId, codeHash: legacyRecoveryHash(code), usedAt: null },
    data: { usedAt: new Date(), codeHash: hashRecoveryCode(code) },
  });
  return legacy.count === 1;
}

export async function remainingRecoveryCodes(userId: string): Promise<number> {
  return prisma.adminRecoveryCode.count({ where: { userId, usedAt: null } });
}

// --- Enrôlement ---

export async function startEnrollment(userId: string): Promise<string> {
  const secret = generateTotpSecret();
  await prisma.user.update({ where: { id: userId }, data: { totpPendingSecretEncrypted: encrypt(secret) } });
  return secret;
}

/** Active la 2FA si le code correspond au secret en attente. Renvoie les codes de secours, sinon null. */
export async function confirmEnrollment(userId: string, code: string): Promise<string[] | null> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.totpPendingSecretEncrypted) return null;
  const step = matchTotpStep(decrypt(user.totpPendingSecretEncrypted), code);
  if (step === null) return null;
  await prisma.user.update({
    where: { id: userId },
    data: {
      totpSecretEncrypted: user.totpPendingSecretEncrypted,
      totpPendingSecretEncrypted: null,
      totpEnabledAt: new Date(),
      totpLastStep: step,
    },
  });
  return regenerateRecoveryCodes(userId);
}

/** Récupération (console du CT) : 2FA désactivée, codes et sessions supprimés. */
export async function resetTwoFactor(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        totpSecretEncrypted: null,
        totpPendingSecretEncrypted: null,
        totpEnabledAt: null,
        totpLastStep: null,
        failedLogins: 0,
        lockedUntil: null,
      },
    }),
    prisma.adminRecoveryCode.deleteMany({ where: { userId } }),
    prisma.adminLoginChallenge.deleteMany({ where: { userId } }),
    prisma.session.deleteMany({ where: { userId } }),
  ]);
}
