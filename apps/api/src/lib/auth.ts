import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getCookieSecure } from "@/lib/env.js";
import { prisma } from "@/lib/prisma.js";

export const SESSION_COOKIE = "kz_hub_session";
/** Session : 7 jours au plus depuis la connexion, close après 24 h sans requête (comme l'ERP). */
export const SESSION_TTL_MS = 7 * 86_400_000;
export const SESSION_IDLE_MS = 86_400_000;
/** lastSeenAt réécrit au plus toutes les 5 minutes (pas une écriture par requête). */
const SESSION_TOUCH_MS = 5 * 60_000;

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
};

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
    sessionId?: string;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return argon2.verify(passwordHash, password);
}

/** La base ne garde que le SHA-256 du jeton : une copie de la base ne donne pas de session valide. */
const sessionIdOf = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({ data: { id: sessionIdOf(token), userId, expiresAt, lastSeenAt: new Date() } });
  return { token, expiresAt };
}

export async function destroySession(sessionId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { id: sessionId } });
}

export async function resolveSession(token: string | undefined): Promise<{ user: AuthUser; sessionId: string } | null> {
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { id: sessionIdOf(token) },
    include: { user: true },
  });
  if (!session) return null;
  const now = Date.now();
  const expired =
    session.expiresAt.getTime() < now ||
    session.createdAt.getTime() + SESSION_TTL_MS < now ||
    (session.lastSeenAt !== null && session.lastSeenAt.getTime() + SESSION_IDLE_MS < now);
  if (expired) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  if (!session.lastSeenAt || session.lastSeenAt.getTime() + SESSION_TOUCH_MS < now) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } }).catch(() => undefined);
  }
  return {
    sessionId: session.id,
    user: { id: session.user.id, email: session.user.email, name: session.user.name },
  };
}

function cookieOptions(request: FastifyRequest) {
  return {
    path: "/",
    httpOnly: true,
    // Outil sans lien entrant légitime : Strict (le CSRF est aussi bloqué par la garde d'origine).
    sameSite: "strict" as const,
    // Par le tunnel, la page est en HTTPS même si COOKIE_SECURE=false en local.
    secure: getCookieSecure() || request.viaTunnel,
  };
}

export function setSessionCookie(request: FastifyRequest, reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions(request), expires: expiresAt });
}

export function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, cookieOptions(request));
}

export async function attachUser(request: FastifyRequest): Promise<void> {
  const resolved = await resolveSession(request.cookies[SESSION_COOKIE]);
  if (resolved) {
    request.user = resolved.user;
    request.sessionId = resolved.sessionId;
  }
}

/** Garde de chaque route métier : 401 sans session valide. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await attachUser(request);
  if (!request.user) {
    const err = new Error("Non authentifié") as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }
  void reply;
}
