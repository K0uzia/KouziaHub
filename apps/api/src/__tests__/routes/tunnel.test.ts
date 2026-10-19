import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "@/app.js";
import { encrypt } from "@/lib/crypto.js";
import { assertSecurityEnv } from "@/lib/env.js";
import { base32Decode, generateTotpSecret, hotp, totpStep } from "@/lib/admin/totp.js";
import { LOCK_STEPS_MS } from "@/lib/admin/two-factor.js";
import { createServices } from "@/lib/services.js";
import type { PushService } from "@/lib/push/service.js";
import { FakeCloudflare } from "@/lib/cloudflare/fake.js";
import { prisma, resetDb } from "../helpers/db.js";
import { createAdmin, TEST_EMAIL, TEST_PASSWORD } from "../helpers/auth.js";

// Hub sans Cloudflare Access (décision du 19/10/2026) : par le tunnel, seul hub.kouzia.com est servi, la
// connexion exige le code à 6 chiffres, la limite de débit et le verrouillage remplacent le filtre amont.

const HUB = "hub.kouzia.com";
const ORIGIN = `https://${HUB}`;
const TUNNEL = { remoteAddress: "127.0.0.1" };
const tunnelHeaders = (extra: Record<string, string> = {}, ip = "203.0.113.9") => ({
  host: HUB,
  origin: ORIGIN,
  "cf-connecting-ip": ip,
  "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36",
  ...extra,
});

let app: FastifyInstance;
const sent: Array<{ title: string; body: string }> = [];
const push = { sendToAll: vi.fn(async (p: { title: string; body: string }) => (sent.push(p), { sent: 1, failed: 0, removed: 0 })) };

beforeEach(async () => {
  await resetDb();
  sent.length = 0;
  process.env.TRUST_PROXY = "loopback";
  process.env.HUB_PUBLIC_ORIGIN = ORIGIN;
  app = await buildApp({
    silent: true,
    serveStatic: false,
    accessVerifier: null,
    services: createServices({ cloudflare: new FakeCloudflare(), chromiumPath: null, push: push as unknown as PushService }),
  });
});
afterEach(async () => {
  await app.close();
  delete process.env.TRUST_PROXY;
  delete process.env.HUB_PUBLIC_ORIGIN;
});

/** Compte avec la 2FA active ; renvoie de quoi produire les codes. */
async function adminWithTwoFactor(): Promise<{ code: (offset?: number) => string }> {
  const { id } = await createAdmin();
  const secret = generateTotpSecret();
  await prisma.user.update({ where: { id }, data: { totpSecretEncrypted: encrypt(secret), totpEnabledAt: new Date() } });
  return { code: (offset = 0) => hotp(base32Decode(secret), totpStep(Date.now()) + offset) };
}

const login = (headers = tunnelHeaders(), password = TEST_PASSWORD) =>
  app.inject({ method: "POST", url: "/api/auth/login", ...TUNNEL, headers, payload: { email: TEST_EMAIL, password } });

/** Connexion complète par le tunnel : mot de passe puis code. */
async function fullLogin(code: string, extra: Record<string, string> = {}) {
  const first = await login(tunnelHeaders(extra));
  expect(first.json()).toEqual({ mfaRequired: true });
  const challenge = first.cookies.find((c) => c.name === "kz_hub_mfa")!;
  const cookie = [extra.cookie, `kz_hub_mfa=${challenge.value}`].filter(Boolean).join("; ");
  return app.inject({ method: "POST", url: "/api/auth/2fa", ...TUNNEL, headers: tunnelHeaders({ ...extra, cookie }), payload: { code } });
}

describe("par le tunnel, sans Cloudflare Access", () => {
  it("Access facultatif : le hub démarre en production sans CF_ACCESS_*", () => {
    const previous = { env: process.env.NODE_ENV, key: process.env.ENCRYPTION_KEY };
    process.env.NODE_ENV = "production";
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    try {
      expect(process.env.CF_ACCESS_TEAM_DOMAIN ?? "").toBe("");
      expect(() => assertSecurityEnv()).not.toThrow();
    } finally {
      process.env.NODE_ENV = previous.env;
      process.env.ENCRYPTION_KEY = previous.key;
    }
  });

  it("connexion sans 2FA refusée (403), sans session ouverte", async () => {
    await createAdmin();
    const res = await login();
    expect(res.statusCode).toBe(403);
    expect(res.cookies.find((c) => c.name === "kz_hub_session")).toBeUndefined();
  });

  it("connexion avec 2FA acceptée : cookie Secure, HttpOnly, SameSite=Strict ; journal avec l'IP, sans secret", async () => {
    const { code } = await adminWithTwoFactor();
    const res = await fullLogin(code());
    expect(res.statusCode).toBe(200);
    const session = res.cookies.find((c) => c.name === "kz_hub_session")!;
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict" });
    const events = await prisma.auditEvent.findMany({ where: { action: "auth.login", result: "ok" } });
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toBe("IP 203.0.113.9, par Internet (tunnel), Chrome sur Android");
    const all = JSON.stringify(await prisma.auditEvent.findMany());
    expect(all).not.toContain(TEST_PASSWORD);
  });

  it("mauvais code : refus journalisé avec l'IP", async () => {
    const { code } = await adminWithTwoFactor();
    const res = await fullLogin(code(10));
    expect(res.statusCode).toBe(401);
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: "auth.2fa" } });
    expect(event).toMatchObject({ result: "error", detail: "code refusé (IP 203.0.113.9, par Internet (tunnel), Chrome sur Android)" });
  });

  it("hôte inconnu : 404 partout (API, santé, interface), même avec X-Forwarded-Host", async () => {
    await createAdmin();
    for (const url of ["/api/auth/me", "/api/health", "/", "/api/sites"]) {
      const res = await app.inject({ method: "GET", url, ...TUNNEL, headers: tunnelHeaders({ host: "autre.kouzia.com", "x-forwarded-host": HUB }) });
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toEqual({ error: "Not found" });
    }
    const post = await app.inject({ method: "POST", url: "/api/auth/login", ...TUNNEL, headers: tunnelHeaders({ host: "kouzia-hub.pages.dev" }), payload: { email: TEST_EMAIL, password: TEST_PASSWORD } });
    expect(post.statusCode).toBe(404);
    // L'hôte du hub, lui, répond.
    expect((await app.inject({ method: "GET", url: "/api/health", ...TUNNEL, headers: tunnelHeaders() })).json()).toEqual({ ok: true });
  });

  it("sans HUB_PUBLIC_ORIGIN, rien n'est servi par le tunnel ; le réseau local n'est pas concerné", async () => {
    await app.close();
    delete process.env.HUB_PUBLIC_ORIGIN;
    app = await buildApp({ silent: true, serveStatic: false, accessVerifier: null });
    expect((await app.inject({ method: "GET", url: "/api/health", ...TUNNEL, headers: tunnelHeaders() })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
  });

  it("limite de débit : 5 essais par quart d'heure et par IP, puis 429 ; une autre IP n'est pas bloquée", async () => {
    await createAdmin();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await login(tunnelHeaders(), "faux")).statusCode);
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes[5]).toBe(429);
    // Le compte, lui, est verrouillé après 5 échecs : la bonne réponse d'une autre IP est refusée aussi.
    const other = await login(tunnelHeaders({}, "198.51.100.7"));
    expect(other.statusCode).toBe(401);
  });

  it("verrouillage progressif : 15 min, puis 1 h au verrouillage suivant dans les 24 h", async () => {
    const { id } = await createAdmin();
    const lockFor = async (ip: string) => {
      for (let i = 0; i < 5; i++) await login(tunnelHeaders({}, ip), "faux");
      const user = await prisma.user.findUniqueOrThrow({ where: { id } });
      return user.lockedUntil!.getTime() - Date.now();
    };
    const first = await lockFor("198.51.100.1");
    expect(first).toBeGreaterThan(LOCK_STEPS_MS[0] - 60_000);
    expect(first).toBeLessThanOrEqual(LOCK_STEPS_MS[0]);
    await prisma.user.update({ where: { id }, data: { lockedUntil: null } });
    const second = await lockFor("198.51.100.2");
    expect(second).toBeGreaterThan(LOCK_STEPS_MS[1] - 60_000);
    expect(second).toBeLessThanOrEqual(LOCK_STEPS_MS[1]);
    const locks = await prisma.auditEvent.findMany({ where: { action: "auth.lock" }, orderBy: { at: "asc" } });
    expect(locks.map((l) => l.detail)).toEqual([
      "compte verrouillé 15 min après 5 échecs (IP 198.51.100.1)",
      "compte verrouillé 1 h après 5 échecs (IP 198.51.100.2)",
    ]);
  });

  it("notification à chaque connexion réussie depuis un nouvel appareil, pas depuis un appareil connu", async () => {
    const { code } = await adminWithTwoFactor();
    // Tout premier appareil : rien à signaler.
    const first = await fullLogin(code());
    expect(first.statusCode).toBe(200);
    const device = first.cookies.find((c) => c.name === "kz_hub_device")!;
    expect(device).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/api/auth" });
    expect(sent).toHaveLength(0);
    // Même appareil (cookie gardé) : rien.
    // Anti-rejeu remis à zéro : chaque connexion du test peut reprendre le code du moment.
    await prisma.user.updateMany({ data: { totpLastStep: null } });
    const again = await fullLogin(code(), { cookie: `kz_hub_device=${device.value}` });
    expect(again.statusCode).toBe(200);
    expect(sent).toHaveLength(0);
    // Autre appareil : une alerte, avec l'IP, et « nouvel appareil » au journal.
    await prisma.user.updateMany({ data: { totpLastStep: null } });
    const other = await fullLogin(code(), { "cf-connecting-ip": "198.51.100.44" });
    expect(other.statusCode).toBe(200);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.title).toBe("Nouvelle connexion au hub");
    expect(sent[0]!.body).toMatch(/^Chrome sur Android, IP 198\.51\.100\.44, le .+\. Pas vous \? Sur le serveur : hubctl 2fa-reset, puis hubctl admin\.$/);
    const last = await prisma.auditEvent.findFirstOrThrow({ where: { action: "auth.login", result: "ok" }, orderBy: { at: "desc" } });
    expect(last.detail).toMatch(/IP 198\.51\.100\.44.*nouvel appareil$/);
  });
});
