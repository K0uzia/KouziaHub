import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LicenseDetail, SoftwareCatalog, SoftwareDetail } from "@/contract.js";
import { ErpUnavailableError, type ErpDirectory } from "@/lib/erp/types.js";
import { forgetSigningKey } from "@/lib/licenses/signer.js";
import { addMonths, parisToday, verifyTb1 } from "@/lib/licenses/tb1.js";
import { prisma, resetDb } from "../helpers/db.js";
import { buildTestHub, type TestHub } from "../helpers/hub.js";

// docs/licences-logiciels.md, section 10. Paire générée pour le test, écrite dans un fichier temporaire.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keyFile = join(mkdtempSync(join(tmpdir(), "kouzia-hub-tracebay-")), "tracebay-ed25519.pem");
writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });

let hub: TestHub;
beforeEach(async () => {
  await resetDb();
  forgetSigningKey();
  process.env.TRACEBAY_LICENSE_KEY_FILE = keyFile;
  hub = await buildTestHub();
});
afterEach(async () => {
  await hub.app.close();
  delete process.env.TRACEBAY_LICENSE_KEY_FILE;
  forgetSigningKey();
});

const get = <T>(url: string) => hub.app.inject({ method: "GET", url, headers: hub.headers }).then((r) => ({ status: r.statusCode, body: r.json() as T }));
const emit = (payload: Record<string, unknown>) => hub.app.inject({ method: "POST", url: "/api/logiciels/tracebay/cles", headers: hub.headers, payload });

describe("page Logiciels : émission des clés Tracebay", () => {
  it("catalogue : Tracebay créé au premier accès, compteurs à zéro ; logiciel inconnu en 404", async () => {
    const res = await get<SoftwareCatalog>("/api/logiciels");
    expect(res.body.software).toEqual([
      {
        slug: "tracebay",
        name: "Tracebay",
        format: "TB1",
        keyPrefix: "TB1",
        description: null,
        demoUrl: null,
        releasesUrl: null,
        thumbnailUrl: null,
        thumbnailFit: null,
        thumbnailColor: null,
        signing: true,
        counts: { active: 0, expiring: 0, expired: 0 },
        nextExpiry: null,
      },
    ]);
    expect((await get("/api/logiciels/inconnu")).status).toBe(404);
    const detail = await get<SoftwareDetail>("/api/logiciels/tracebay");
    expect(detail.body).toMatchObject({ signing: true, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(), today: parisToday(), licenses: [] });
  });

  it("émet une clé signée (accents, guillemet, client ERP), vérifiable avec la publique ; la liste ne contient pas la clé", async () => {
    const res = await emit({ entreprise: '  Société "Ébène"  ', erpClientId: "demo-01", contact: "contact@ebene.fr", notes: "Démo salon", months: 12 });
    expect(res.statusCode).toBe(201);
    const created = res.json() as LicenseDetail;
    const today = parisToday();
    expect(created).toMatchObject({ entreprise: 'Société "Ébène"', erpClientId: "demo-01", clientName: "Exemple 01 : boulangerie", emise: today, expire: addMonths(today, 12), status: "active", contact: "contact@ebene.fr", notes: "Démo salon" });
    const verified = verifyTb1(created.cle, publicKey);
    expect(verified).toEqual({ ok: true, payload: { v: 1, id: created.id, entreprise: 'Société "Ébène"', emise: today, expire: addMonths(today, 12) } });

    const list = await get<SoftwareDetail>("/api/logiciels/tracebay");
    expect(list.body.licenses).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain("TB1.");
    expect(JSON.stringify(list.body)).not.toContain("contact@ebene.fr");
    const one = await get<LicenseDetail>(`/api/logiciels/tracebay/cles/${created.id}`);
    expect(one.body.cle).toBe(created.cle);
    expect(one.body.contact).toBe("contact@ebene.fr");

    // Base copiée : ni la clé ni le contact en clair.
    const row = await prisma.license.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.keyEncrypted).not.toContain("TB1.");
    expect(row.contactEncrypted).not.toContain("ebene");
    // Journal : sans la chaîne TB1 ni le contact.
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: "licence.emettre" } });
    expect(event.detail).toBe(`tracebay : Société "Ébène", expire le ${addMonths(today, 12)}`);
    expect(JSON.stringify(await prisma.auditEvent.findMany())).not.toMatch(/TB1\.|contact@ebene\.fr|tracebay-ed25519/);
  });

  it("sans fichier de clé : liste lisible, drapeau signing faux, émission en 503, rien en base", async () => {
    process.env.TRACEBAY_LICENSE_KEY_FILE = join(tmpdir(), "absent-kouzia-hub.pem");
    forgetSigningKey();
    expect((await get<SoftwareDetail>("/api/logiciels/tracebay")).body.signing).toBe(false);
    const res = await emit({ entreprise: "Atelier Nord", months: 12 });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "signing_unavailable", error: "Émission impossible : la clé de signature est absente sur le serveur." });
    expect(await prisma.license.count()).toBe(0);
  });

  it("durée : mois ou date, pas les deux, pas aucune, bornes ; nom vide refusé", async () => {
    for (const bad of [{}, { months: 12, expire: "2099-01-01" }, { months: 40 }, { expire: "2000-01-01" }]) {
      const res = await emit({ entreprise: "Atelier Nord", ...bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await emit({ entreprise: "   ", months: 12 })).json()).toMatchObject({ code: "entreprise" });
    const dated = await emit({ entreprise: "Atelier Nord", expire: parisToday() });
    expect(dated.statusCode).toBe(201);
    expect((dated.json() as LicenseDetail).status).toBe("expiring");
    expect(await prisma.license.count()).toBe(1);
  });

  it("client ERP inconnu : 400 ; ERP indisponible : 503 ; rien en base", async () => {
    expect((await emit({ entreprise: "Atelier Nord", erpClientId: "client-absent", months: 12 })).statusCode).toBe(400);
    await hub.app.close();
    const down: ErpDirectory = {
      mode: "http",
      list: async () => {
        throw new ErpUnavailableError("coupé");
      },
      get: async () => {
        throw new ErpUnavailableError("coupé");
      },
    } as unknown as ErpDirectory;
    hub = await buildTestHub({ erp: down });
    const res = await emit({ entreprise: "Atelier Nord", erpClientId: "demo-01", months: 12 });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "erp_unavailable" });
    expect(await prisma.license.count()).toBe(0);
  });

  it("PATCH : notes, contact et client seulement ; entreprise et dates refusées ; journal sans contact", async () => {
    const created = (await emit({ entreprise: "Atelier Nord", months: 12 })).json() as LicenseDetail;
    const url = `/api/logiciels/tracebay/cles/${created.id}`;
    for (const field of [{ entreprise: "Autre" }, { expire: "2030-01-01" }, { emise: "2026-01-01" }]) {
      expect((await hub.app.inject({ method: "PATCH", url, headers: hub.headers, payload: field })).statusCode, JSON.stringify(field)).toBe(400);
    }
    const ok = await hub.app.inject({ method: "PATCH", url, headers: hub.headers, payload: { notes: "Renouvelée en 2027", contact: "jean@atelier.fr", erpClientId: "demo-02" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ notes: "Renouvelée en 2027", contact: "jean@atelier.fr", erpClientId: "demo-02", entreprise: "Atelier Nord", cle: created.cle });
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: "licence.modifier" } });
    expect(event.detail).toBe(`tracebay : clé ${created.id}`);
    expect(hub.app.hasRoute({ method: "DELETE", url: "/api/logiciels/:slug/cles/:id" })).toBe(false);
  });

  it("tri : expiration la plus proche d'abord, puis entreprise ; compteurs par état", async () => {
    await emit({ entreprise: "Zèbre", months: 12 });
    await emit({ entreprise: "Abeille", months: 12 });
    await emit({ entreprise: "Court", expire: parisToday() });
    // Clé déjà expirée : écrite directement (une émission part toujours d'aujourd'hui).
    const software = await prisma.software.findUniqueOrThrow({ where: { slug: "tracebay" } });
    await prisma.license.create({ data: { id: "ancienne", softwareId: software.id, entreprise: "Ancienne", keyEncrypted: "x", emise: "2024-01-01", expire: "2025-01-01" } });
    const detail = (await get<SoftwareDetail>("/api/logiciels/tracebay")).body;
    expect(detail.licenses.map((l) => l.entreprise)).toEqual(["Ancienne", "Court", "Abeille", "Zèbre"]);
    expect(detail.software.counts).toEqual({ active: 2, expiring: 1, expired: 1 });
    expect(detail.software.nextExpiry).toEqual({ expire: parisToday(), entreprise: "Court" });
  });

  it("routes derrière la session", async () => {
    expect((await hub.app.inject({ method: "GET", url: "/api/logiciels" })).statusCode).toBe(401);
    expect((await hub.app.inject({ method: "POST", url: "/api/logiciels/tracebay/cles", headers: { origin: "http://localhost:5174" }, payload: { entreprise: "x", months: 1 } })).statusCode).toBe(401);
  });
});
