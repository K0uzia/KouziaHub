import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AccessVerifier } from "@/lib/access.js";
import { buildApp, ROBOTS_TXT } from "@/app.js";

const TEAM = "kouzia.cloudflareaccess.com";
const AUD = "aud-de-test";

function keyPair(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } };
}

function jwt(privateKey: KeyObject, kid: string, claims: Record<string, unknown>) {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const s = sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url");
  return `${h}.${p}.${s}`;
}

const now = Math.floor(Date.now() / 1000);
const valid = { aud: [AUD], iss: `https://${TEAM}`, exp: now + 600, nbf: now - 10, email: "alexandre@example.test" };

describe("jeton Cloudflare Access", () => {
  const k1 = keyPair("k1");
  const other = keyPair("k1");
  let fetched = 0;
  const verifier = new AccessVerifier({ teamDomain: TEAM, audience: AUD, email: null }, async (url) => {
    fetched++;
    expect(url).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
    return { keys: [k1.jwk] };
  });

  it("accepte un jeton signé, destiné à l'application et en cours de validité", async () => {
    expect(await verifier.verify(jwt(k1.privateKey, "k1", valid))).toBe(true);
  });

  it.each([
    ["mauvaise audience", { ...valid, aud: ["autre"] }],
    ["mauvais émetteur", { ...valid, iss: "https://evil.cloudflareaccess.com" }],
    ["expiré", { ...valid, exp: now - 3600 }],
    ["pas encore valide", { ...valid, nbf: now + 3600 }],
  ])("refuse un jeton %s", async (_name, claims) => {
    expect(await verifier.verify(jwt(k1.privateKey, "k1", claims))).toBe(false);
  });

  it("refuse une signature d'une autre clé, un jeton absent ou mal formé", async () => {
    expect(await verifier.verify(jwt(other.privateKey, "k1", valid))).toBe(false);
    expect(await verifier.verify(undefined)).toBe(false);
    expect(await verifier.verify("abc.def")).toBe(false);
    expect(await verifier.verify(`${Buffer.from('{"alg":"none"}').toString("base64url")}.e30.`)).toBe(false);
  });

  it("garde les clés en cache", () => {
    expect(fetched).toBe(1);
  });

  it("contrôle l'adresse quand CF_ACCESS_EMAIL est posée", async () => {
    const strict = new AccessVerifier({ teamDomain: TEAM, audience: AUD, email: "alexandre@example.test" }, async () => ({ keys: [k1.jwk] }));
    expect(await strict.verify(jwt(k1.privateKey, "k1", valid))).toBe(true);
    expect(await strict.verify(jwt(k1.privateKey, "k1", { ...valid, email: "autre@example.test" }))).toBe(false);
  });
});

describe("garde Access et en-têtes", () => {
  const k = keyPair("k2");
  let app: FastifyInstance;
  beforeAll(async () => {
    const verifier = new AccessVerifier({ teamDomain: TEAM, audience: AUD, email: null }, async () => ({ keys: [k.jwk] }));
    app = await buildApp({ silent: true, serveStatic: false, accessVerifier: verifier });
  });
  afterAll(async () => {
    await app.close();
  });

  it("répond 404 sans jeton, sauf au contrôle de santé", async () => {
    expect((await app.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
  });

  it("laisse passer avec un jeton valide", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { "cf-access-jwt-assertion": jwt(k.privateKey, "k2", valid) },
    });
    expect(res.statusCode).toBe(200);
  });

  it("pose noindex et les en-têtes de sécurité, sert robots.txt en Disallow", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/robots.txt",
      headers: { "cf-access-jwt-assertion": jwt(k.privateKey, "k2", valid) },
    });
    expect(res.body).toBe(ROBOTS_TXT);
    expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(String(res.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
    expect(res.headers["permissions-policy"]).toContain("camera=()");
  });
});
