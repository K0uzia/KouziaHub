import type { FastifyInstance } from "fastify";
import { hashPassword } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";

export const TEST_EMAIL = "alexandre@example.test";
export const TEST_PASSWORD = "mot-de-passe-de-test-assez-long";

export async function createAdmin(): Promise<{ id: string }> {
  return prisma.user.create({
    data: { email: TEST_EMAIL, passwordHash: await hashPassword(TEST_PASSWORD) },
    select: { id: true },
  });
}

/** Ouvre une session (hors tunnel, sans 2FA) et renvoie l'en-tête Cookie à rejouer. */
export async function loginCookie(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: "http://localhost:5174" },
    payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
  });
  if (res.statusCode !== 200) throw new Error(`login ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === "kz_hub_session");
  if (!cookie) throw new Error("cookie de session absent");
  return `kz_hub_session=${cookie.value}`;
}

/** En-têtes d'une requête authentifiée de l'interface (cookie + origine autorisée). */
export const authed = (cookie: string) => ({ cookie, origin: "http://localhost:5174" });
