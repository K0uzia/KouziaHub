import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "@/app.js";
import { hotp, base32Decode, totpStep } from "@/lib/admin/totp.js";
import { resetDb, prisma } from "../helpers/db.js";
import { authed, createAdmin, loginCookie, TEST_EMAIL, TEST_PASSWORD } from "../helpers/auth.js";

const ORIGIN = { origin: "http://localhost:5174" };

describe("connexion", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ silent: true, serveStatic: false, accessVerifier: null });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    await createAdmin();
  });

  it("refuse un mauvais mot de passe avec le même message qu'un compte inconnu", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/auth/login", headers: ORIGIN, payload: { email: TEST_EMAIL, password: "faux" } });
    const unknown = await app.inject({ method: "POST", url: "/api/auth/login", headers: ORIGIN, payload: { email: "x@example.test", password: "faux" } });
    expect(bad.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(bad.json()).toEqual(unknown.json());
  });

  it("ouvre une session hors tunnel sans 2FA, puis /me renvoie l'utilisateur", async () => {
    const cookie = await loginCookie(app);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.json().user.email).toBe(TEST_EMAIL);
  });

  it("refuse la connexion par le tunnel tant que la 2FA n'est pas activée", async () => {
    process.env.TRUST_PROXY = "loopback";
    process.env.HUB_PUBLIC_ORIGIN = "https://hub.kouzia.com";
    const tunnelApp = await buildApp({ silent: true, serveStatic: false, accessVerifier: null });
    const res = await tunnelApp.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "127.0.0.1",
      headers: { host: "hub.kouzia.com", origin: "https://hub.kouzia.com", "cf-connecting-ip": "203.0.113.9" },
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
    });
    await tunnelApp.close();
    delete process.env.TRUST_PROXY;
    delete process.env.HUB_PUBLIC_ORIGIN;
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/hubctl admin/);
  });

  it("en production, exige la 2FA quelle que soit la provenance (TRUST_PROXY mal réglé) et compte les échecs", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      // Requête locale, sans en-tête du tunnel : refusée quand même.
      const res = await app.inject({ method: "POST", url: "/api/auth/login", headers: ORIGIN, payload: { email: TEST_EMAIL, password: TEST_PASSWORD } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/double authentification.*hubctl admin/);
      expect(res.cookies.find((c) => c.name === "kz_hub_session")).toBeUndefined();
      // Mauvais mot de passe : échec compté même hors tunnel.
      await app.inject({ method: "POST", url: "/api/auth/login", headers: ORIGIN, payload: { email: TEST_EMAIL, password: "faux-mot-de-passe" } });
      const user = await prisma.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
      expect(user.failedLogins).toBe(1);
    } finally {
      process.env.NODE_ENV = previous;
    }
    // En dev, rien ne change : la connexion locale sans 2FA reste possible.
    expect((await app.inject({ method: "POST", url: "/api/auth/login", headers: ORIGIN, payload: { email: TEST_EMAIL, password: TEST_PASSWORD } })).statusCode).toBe(200);
  });

  it("demande le code TOTP quand la 2FA est active et refuse un code rejoué", async () => {
    const cookie = await loginCookie(app);
    const setup = await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: authed(cookie) });
    const secret = setup.json().secret as string;
    // Un seul code, rejoué tel quel : recalculé, il changerait au passage d'un pas de 30 s et serait valide.
    const used = hotp(base32Decode(secret), totpStep(Date.now()));
    const enable = await app.inject({ method: "POST", url: "/api/auth/2fa/enable", headers: authed(cookie), payload: { code: used } });
    expect(enable.json().recoveryCodes).toHaveLength(10);

    const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: ORIGIN, payload: { email: TEST_EMAIL, password: TEST_PASSWORD } });
    expect(login.json()).toEqual({ mfaRequired: true });
    const challenge = login.cookies.find((c) => c.name === "kz_hub_mfa")!;
    // Le code de l'activation a déjà servi : refusé (anti-rejeu).
    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/2fa",
      headers: { ...ORIGIN, cookie: `kz_hub_mfa=${challenge.value}` },
      payload: { code: used },
    });
    expect(replay.statusCode).toBe(401);
    const recovery = await app.inject({
      method: "POST",
      url: "/api/auth/2fa",
      headers: { ...ORIGIN, cookie: `kz_hub_mfa=${challenge.value}` },
      payload: { recoveryCode: enable.json().recoveryCodes[0] },
    });
    expect(recovery.statusCode).toBe(200);
    expect(recovery.cookies.some((c) => c.name === "kz_hub_session")).toBe(true);
  });

  it("codes TOTP envoyés en parallèle depuis plusieurs adresses : 5 essais au plus par connexion (audit du 27/10/2026)", async () => {
    // Instance à part : ses connexions n'épuisent pas la limite de débit des autres tests.
    const own = await buildApp({ silent: true, serveStatic: false, accessVerifier: null });
    try {
      const cookie = await loginCookie(own);
      const secret = (await own.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: authed(cookie) })).json().secret as string;
      await own.inject({ method: "POST", url: "/api/auth/2fa/enable", headers: authed(cookie), payload: { code: hotp(base32Decode(secret), totpStep(Date.now())) } });
      const login = await own.inject({ method: "POST", url: "/api/auth/login", headers: ORIGIN, payload: { email: TEST_EMAIL, password: TEST_PASSWORD } });
      const challenge = login.cookies.find((c) => c.name === "kz_hub_mfa")!;
      const tries = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          own.inject({
            method: "POST",
            url: "/api/auth/2fa",
            remoteAddress: `192.0.2.${i + 1}`,
            headers: { ...ORIGIN, cookie: `kz_hub_mfa=${challenge.value}` },
            payload: { code: String(100000 + i) },
          }),
        ),
      );
      const evaluated = tries.filter((r) => r.json().error === "Code incorrect.").length;
      expect(evaluated).toBeGreaterThan(0);
      expect(evaluated).toBeLessThanOrEqual(5);
      expect(tries.every((r) => r.statusCode === 401)).toBe(true);
    } finally {
      await own.close();
    }
  });

  it("refuse une mutation venue d'une autre origine", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: "https://evil.example" },
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(403);
  });

  it("ne garde en base que l'empreinte du jeton de session", async () => {
    const cookie = await loginCookie(app);
    const token = cookie.split("=")[1]!;
    const sessions = await prisma.session.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).not.toBe(token);
  });
});
