import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LicenseDetail, SoftwareCatalog, SoftwareDetail } from "@/contract.js";
import { keyFileOf, forgetSigningKey } from "@/lib/licenses/signer.js";
import { verifyKz1 } from "@/lib/licenses/kz1.js";
import { verifyTb1 } from "@/lib/licenses/tb1.js";
import { prisma, resetDb } from "../helpers/db.js";
import { buildTestHub, multipart, type TestHub } from "../helpers/hub.js";

// « Nouveau logiciel » (docs/licences-logiciels.md, sections 3.7, 4 et 6) : une paire par logiciel dans le même dossier,
// Tracebay inchangé (TB1, son fichier), les autres en KZ1 avec le champ « logiciel » signé.
const dir = mkdtempSync(join(tmpdir(), "kouzia-hub-licences-"));
const pair = (slug: string) => {
  const p = generateKeyPairSync("ed25519");
  writeFileSync(join(dir, `${slug}-ed25519.pem`), p.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return p;
};
const tracebay = pair("tracebay");
const atelier = pair("atelier");

let hub: TestHub;
beforeEach(async () => {
  await resetDb();
  forgetSigningKey();
  process.env.TRACEBAY_LICENSE_KEY_FILE = join(dir, "tracebay-ed25519.pem");
  hub = await buildTestHub();
});
afterEach(async () => {
  await hub.app.close();
  delete process.env.TRACEBAY_LICENSE_KEY_FILE;
  delete process.env.LICENSE_KEY_DIR;
  forgetSigningKey();
});

const send = (method: "POST" | "PATCH" | "DELETE" | "GET", url: string, payload?: Record<string, unknown>) =>
  hub.app.inject({ method, url, headers: hub.headers, ...(payload ? { payload } : {}) });
const create = (over: Record<string, unknown> = {}) =>
  send("POST", "/api/logiciels", { name: "Atelier", slug: "atelier", keyPrefix: "ATL1", description: "Gestion d'atelier", demoUrl: "https://demo.atelier.fr", ...over });

describe("fichier de clé par logiciel", () => {
  it("Tracebay garde TRACEBAY_LICENSE_KEY_FILE ; les autres : <slug>-ed25519.pem dans LICENSE_KEY_DIR, sinon le dossier de Tracebay", () => {
    expect(keyFileOf("tracebay", { TRACEBAY_LICENSE_KEY_FILE: "/etc/kouziahub/tracebay-ed25519.pem" })).toBe("/etc/kouziahub/tracebay-ed25519.pem");
    expect(keyFileOf("atelier", { TRACEBAY_LICENSE_KEY_FILE: "/etc/kouziahub/tracebay-ed25519.pem" })?.replace(/\\/g, "/")).toBe("/etc/kouziahub/atelier-ed25519.pem");
    expect(keyFileOf("atelier", { LICENSE_KEY_DIR: "/srv/cles" })?.replace(/\\/g, "/")).toBe("/srv/cles/atelier-ed25519.pem");
    expect(keyFileOf("tracebay", { LICENSE_KEY_DIR: "/srv/cles" })?.replace(/\\/g, "/")).toBe("/srv/cles/tracebay-ed25519.pem");
    expect(keyFileOf("atelier", {})).toBeNull();
  });
});

describe("page Logiciels : nouveau logiciel", () => {
  it("crée un logiciel KZ1 ; ses clés portent son préfixe et le champ « logiciel » signé avec sa propre paire", async () => {
    const res = await create();
    expect(res.statusCode).toBe(201);
    const detail = res.json() as SoftwareDetail;
    expect(detail.software).toMatchObject({ slug: "atelier", name: "Atelier", format: "KZ1", keyPrefix: "ATL1", demoUrl: "https://demo.atelier.fr/", signing: true });
    expect(detail.publicKey).toBe(atelier.publicKey.export({ type: "spki", format: "pem" }).toString());

    const emitted = await send("POST", "/api/logiciels/atelier/cles", { entreprise: "Société Ébène", months: 12 });
    expect(emitted.statusCode).toBe(201);
    const cle = (emitted.json() as LicenseDetail).cle;
    expect(cle.startsWith("ATL1.")).toBe(true);
    const ok = verifyKz1(cle, { prefix: "ATL1", logiciel: "atelier" }, atelier.publicKey);
    expect(ok).toMatchObject({ ok: true, payload: { v: 1, logiciel: "atelier", entreprise: "Société Ébène" } });
    // Une clé d'un logiciel ne valide jamais un autre : autre paire, autre identifiant attendu, format TB1.
    expect(verifyKz1(cle, { prefix: "ATL1", logiciel: "atelier" }, tracebay.publicKey)).toEqual({ ok: false, reason: "signature" });
    expect(verifyKz1(cle, { prefix: "ATL1", logiciel: "autre" }, atelier.publicKey)).toEqual({ ok: false, reason: "logiciel" });
    expect(verifyTb1(cle, atelier.publicKey)).toEqual({ ok: false, reason: "format" });

    // Tracebay inchangé : TB1, sa paire.
    const tb = (await send("POST", "/api/logiciels/tracebay/cles", { entreprise: "Atelier Nord", months: 12 })).json() as LicenseDetail;
    expect(verifyTb1(tb.cle, tracebay.publicKey)).toMatchObject({ ok: true });

    const catalog = (await send("GET", "/api/logiciels")).json() as SoftwareCatalog;
    expect(catalog.software.map((s) => [s.slug, s.counts.active, s.nextExpiry?.entreprise])).toEqual([
      ["atelier", 1, "Société Ébène"],
      ["tracebay", 1, "Atelier Nord"],
    ]);
    expect(await prisma.auditEvent.count({ where: { action: "logiciel.creer" } })).toBe(1);
  });

  it("sans fichier de clé pour ce logiciel : fiche lisible, émission en 503 (Tracebay non touché)", async () => {
    await create({ slug: "sans-cle", keyPrefix: "SC1", name: "Sans clé" });
    const detail = (await send("GET", "/api/logiciels/sans-cle")).json() as SoftwareDetail;
    expect([detail.signing, detail.publicKey]).toEqual([false, null]);
    expect((await send("POST", "/api/logiciels/sans-cle/cles", { entreprise: "Atelier Nord", months: 12 })).statusCode).toBe(503);
    expect(((await send("GET", "/api/logiciels/tracebay")).json() as SoftwareDetail).signing).toBe(true);
  });

  it("champs refusés : identifiant, préfixe réservé ou mal formé, adresse non https, doublons en 409", async () => {
    for (const [over, code] of [
      [{ slug: "A" }, "slug"],
      [{ slug: "atelier--x" }, "slug"],
      [{ slug: "../etc" }, "slug"],
      [{ keyPrefix: "TB1" }, "keyPrefix"],
      [{ keyPrefix: "KZ1" }, "keyPrefix"],
      [{ keyPrefix: "atl" }, "keyPrefix"],
      [{ name: "  " }, "name"],
      [{ demoUrl: "http://demo.atelier.fr" }, "demoUrl"],
      [{ releasesUrl: "javascript:alert(1)" }, "releasesUrl"],
    ] as const) {
      const res = await create(over);
      expect(res.statusCode, JSON.stringify(over)).toBe(400);
      expect(res.json(), JSON.stringify(over)).toMatchObject({ code });
    }
    expect((await create()).statusCode).toBe(201);
    expect((await create({ keyPrefix: "ATL2" })).json()).toMatchObject({ code: "slug" });
    expect((await create({ slug: "atelier-2" })).json()).toMatchObject({ code: "keyPrefix" });
    expect((await create({ slug: "tracebay", keyPrefix: "TRB" })).statusCode).toBe(409);
    expect(await prisma.software.count()).toBe(2);
  });

  it("PATCH : nom, description et liens ; identifiant, préfixe et format refusés ; vide efface", async () => {
    await create();
    for (const bad of [{ slug: "autre" }, { keyPrefix: "ATL9" }, { format: "TB1" }]) {
      expect((await send("PATCH", "/api/logiciels/atelier", bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    const res = await send("PATCH", "/api/logiciels/atelier", { name: "Atelier Pro", description: "", releasesUrl: "https://github.com/k/atelier/releases" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as SoftwareDetail).software).toMatchObject({ name: "Atelier Pro", description: null, releasesUrl: "https://github.com/k/atelier/releases", keyPrefix: "ATL1" });
  });

  it("suppression : seulement sans clé émise, jamais Tracebay", async () => {
    await create();
    await create({ slug: "vide", keyPrefix: "VID1", name: "Vide" });
    await send("POST", "/api/logiciels/atelier/cles", { entreprise: "Atelier Nord", months: 12 });
    expect((await send("DELETE", "/api/logiciels/atelier")).json()).toMatchObject({ code: "licenses" });
    expect((await send("DELETE", "/api/logiciels/tracebay")).json()).toMatchObject({ code: "tracebay" });
    expect((await send("DELETE", "/api/logiciels/vide")).statusCode).toBe(204);
    expect((await send("GET", "/api/logiciels/vide")).statusCode).toBe(404);
  });

  it("vignette envoyée : gardée entière (WebP à son ratio, transparence), cadrage « logo » par défaut, puis retirée", async () => {
    await create();
    const png = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: "#3366cc" } }).png().toBuffer();
    const body = multipart([], [{ field: "image", filename: "atelier.png", content: png, type: "image/png" }]);
    const res = await hub.app.inject({ method: "POST", url: "/api/logiciels/atelier/vignette", headers: { ...hub.headers, ...body.headers }, payload: body.payload });
    expect(res.statusCode).toBe(200);
    const url = (res.json() as SoftwareDetail).software.thumbnailUrl!;
    expect(url).toMatch(/^\/api\/logiciels\/atelier\/vignette\?v=\d+$/);
    const img = await send("GET", url);
    expect([img.statusCode, img.headers["content-type"]]).toEqual([200, "image/webp"]);
    expect(img.headers["cache-control"]).toMatch(/^private/);
    const meta = await sharp(img.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([960, 600]);
    expect((res.json() as SoftwareDetail).software).toMatchObject({ thumbnailFit: "logo", thumbnailColor: "#0f1f3d" });
    const removed = await send("DELETE", "/api/logiciels/atelier/vignette");
    expect((removed.json() as SoftwareDetail).software).toMatchObject({ thumbnailUrl: null, thumbnailFit: null, thumbnailColor: null });
    expect((await send("GET", "/api/logiciels/atelier/vignette")).statusCode).toBe(404);
  });

  it("cadrage : logo, couleur du logo ou capture ; gardé au renvoi ; image d'avant le réglage (déjà recadrée) refusée", async () => {
    await create();
    const upload = async (content: Buffer) => {
      const body = multipart([], [{ field: "image", filename: "logo.png", content, type: "image/png" }]);
      return (await hub.app.inject({ method: "POST", url: "/api/logiciels/atelier/vignette", headers: { ...hub.headers, ...body.headers }, payload: body.payload })).json() as SoftwareDetail;
    };
    const fit = (thumbnailFit: unknown) => send("PATCH", "/api/logiciels/atelier", { thumbnailFit });
    expect((await fit("logo")).json()).toMatchObject({ code: "thumbnail" });
    // Logo carré transparent : la transparence reste, la couleur vient des pixels opaques.
    const logo = await sharp({ create: { width: 400, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 22, g: 160, b: 133, alpha: 1 } } }).png().toBuffer(), top: 100, left: 100 }])
      .png()
      .toBuffer();
    const sent = await upload(logo);
    expect(sent.software).toMatchObject({ thumbnailFit: "logo", thumbnailColor: "#073028" });
    expect((await sharp((await send("GET", sent.software.thumbnailUrl!)).rawPayload).metadata()).hasAlpha).toBe(true);
    expect(((await fit("capture")).json() as SoftwareDetail).software.thumbnailFit).toBe("capture");
    expect((await fit("zoom")).statusCode).toBe(400);
    // Une nouvelle image garde le cadrage choisi.
    expect((await upload(logo)).software.thumbnailFit).toBe("capture");
    expect(((await fit("logo-couleur")).json() as SoftwareDetail).software.thumbnailFit).toBe("logo-couleur");
    // Image d'avant : chemin sans cadrage enregistré.
    await prisma.software.update({ where: { slug: "atelier" }, data: { thumbnailFit: null } });
    expect(((await send("GET", "/api/logiciels/atelier")).json() as SoftwareDetail).software.thumbnailFit).toBeNull();
    expect((await fit("logo")).statusCode).toBe(409);
    expect((await upload(logo)).software.thumbnailFit).toBe("logo");
  });

  it("routes derrière la session", async () => {
    expect((await hub.app.inject({ method: "POST", url: "/api/logiciels", headers: { origin: "http://localhost:5174" }, payload: { name: "x", slug: "xx", keyPrefix: "XX" } })).statusCode).toBe(401);
    expect((await hub.app.inject({ method: "GET", url: "/api/logiciels/tracebay/vignette" })).statusCode).toBe(401);
  });
});
