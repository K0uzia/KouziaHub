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
    const tunnelApp = await buildApp({ silent: true, serveStatic: false, accessVerifier: null });
    const res = await tunnelApp.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "127.0.0.1",
      headers: { ...ORIGIN, "cf-connecting-ip": "203.0.113.9" },
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
    });
    await tunnelApp.close();
    delete process.env.TRUST_PROXY;
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/hubctl admin/);
  });

  it("demande le code TOTP quand la 2FA est active et refuse un code rejoué", async () => {
    const cookie = await loginCookie(app);
    const setup = await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: authed(cookie) });
    const secret = setup.json().secret as string;
    const code = () => hotp(base32Decode(secret), totpStep(Date.now()));
    const enable = await app.inject({ method: "POST", url: "/api/auth/2fa/enable", headers: authed(cookie), payload: { code: code() } });
    expect(enable.json().recoveryCodes).toHaveLength(10);

    const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: ORIGIN, payload: { email: TEST_EMAIL, password: TEST_PASSWORD } });
    expect(login.json()).toEqual({ mfaRequired: true });
    const challenge = login.cookies.find((c) => c.name === "kz_hub_mfa")!;
    // Le code de l'activation a déjà servi : refusé (anti-rejeu).
    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/2fa",
      headers: { ...ORIGIN, cookie: `kz_hub_mfa=${challenge.value}` },
      payload: { code: code() },
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
