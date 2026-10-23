import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { License, Software } from "@prisma/client";
import { z } from "zod";
import type { LicenseDetail, LicenseSummary, SoftwareCatalog, SoftwareDetail, SoftwareSummary } from "@/contract.js";
import { audit } from "@/lib/audit.js";
import { requireAuth } from "@/lib/auth.js";
import { decrypt, decryptOptional, encrypt, encryptOptional } from "@/lib/crypto.js";
import { ERP_CLIENT_ID, ErpUnavailableError } from "@/lib/erp/types.js";
import { HttpError } from "@/lib/http.js";
import { routeParam } from "@/lib/http-input.js";
import { expiryOf, licenseStatus, normalizeEntreprise, parisToday, signTb1, TB1 } from "@/lib/licenses/tb1.js";
import { signingKey } from "@/lib/licenses/signer.js";
import { prisma } from "@/lib/prisma.js";
import type { Services } from "@/lib/services.js";
import { erpNames } from "@/lib/site-view.js";

// Page Logiciels : registre des clés de licence (docs/licences-logiciels.md, sections 5 et 6). Le hub signe, Tracebay
// vérifie hors ligne. Pas de révocation, pas de suppression : changer le nom ou la date, c'est émettre une nouvelle clé.

const TRACEBAY = { slug: "tracebay", name: "Tracebay", format: TB1 };
const NO_SIGNING = "Émission impossible : la clé de signature est absente sur le serveur.";

const slugParams = z.object({ slug: routeParam });
const keyParams = z.object({ slug: routeParam, id: routeParam });
const erpId = z.string().regex(ERP_CLIENT_ID).nullable().optional();
const createSchema = z
  .object({
    entreprise: z.string().max(1000),
    erpClientId: erpId,
    contact: z.string().max(1000).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    months: z.number().int().optional(),
    expire: z.string().max(10).optional(),
  })
  .strict();
const updateSchema = z
  .object({
    notes: z.string().max(2000).nullable().optional(),
    contact: z.string().max(1000).nullable().optional(),
    erpClientId: erpId,
  })
  .strict();

/** Logiciel connu (Tracebay créé au premier besoin), 404 sinon. */
async function softwareOf(slug: string): Promise<Software> {
  await prisma.software.upsert({ where: { slug: TRACEBAY.slug }, create: TRACEBAY, update: {} });
  const software = await prisma.software.findUnique({ where: { slug } });
  if (!software) throw new HttpError(404, "Logiciel introuvable.");
  return software;
}

function summaryOf(row: License, names: Map<string, string>, today: string): LicenseSummary {
  return {
    id: row.id,
    entreprise: row.entreprise,
    erpClientId: row.erpClientId,
    clientName: row.erpClientId ? (names.get(row.erpClientId) ?? null) : null,
    emise: row.emise,
    expire: row.expire,
    status: licenseStatus(row.expire, today),
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

function detailOf(row: License, names: Map<string, string>, today: string): LicenseDetail {
  return { ...summaryOf(row, names, today), cle: decrypt(row.keyEncrypted), contact: decryptOptional(row.contactEncrypted) };
}

async function countsOf(software: Software, today: string): Promise<SoftwareSummary> {
  const rows = await prisma.license.findMany({ where: { softwareId: software.id }, select: { expire: true } });
  const counts = { active: 0, expiring: 0, expired: 0 };
  for (const r of rows) counts[licenseStatus(r.expire, today)]++;
  return { slug: software.slug, name: software.name, format: software.format, counts };
}

/** Contact : vide ignoré, 200 caractères au plus. */
function contactOf(raw: string | null | undefined): string | null {
  const value = raw?.trim() ?? "";
  if (value.length > 200) throw new HttpError(400, "Contact trop long (200 caractères au plus).", "contact");
  return value || null;
}

const notesOf = (raw: string | null | undefined) => raw?.trim() || null;

async function ensureErpClient(services: Services, erpClientId: string): Promise<void> {
  try {
    if (!(await services.erp.get(erpClientId))) throw new HttpError(400, "Client introuvable dans l'ERP.", "erp_client");
  } catch (err) {
    if (err instanceof ErpUnavailableError) throw new HttpError(503, "Clients de l'ERP indisponibles : réessayez plus tard.", "erp_unavailable");
    throw err;
  }
}

export function licensesRoutes(services: Services): FastifyPluginAsync {
  return async (app) => {
    app.addHook("onRequest", requireAuth);

    app.get("/api/logiciels", async (): Promise<SoftwareCatalog> => {
      await softwareOf(TRACEBAY.slug);
      const today = parisToday();
      const all = await prisma.software.findMany({ orderBy: { name: "asc" } });
      return { software: await Promise.all(all.map((s) => countsOf(s, today))) };
    });

    app.get("/api/logiciels/:slug", async (request): Promise<SoftwareDetail> => {
      const { slug } = slugParams.parse(request.params);
      const software = await softwareOf(slug);
      const today = parisToday();
      const [rows, erp, key] = await Promise.all([
        prisma.license.findMany({ where: { softwareId: software.id } }),
        erpNames(services),
        signingKey(),
      ]);
      const licenses = rows
        .map((r) => summaryOf(r, erp.names, today))
        .sort((a, b) => a.expire.localeCompare(b.expire) || a.entreprise.localeCompare(b.entreprise, "fr"));
      return { software: await countsOf(software, today), signing: key !== null, today, licenses };
    });

    app.post("/api/logiciels/:slug/cles", async (request, reply): Promise<LicenseDetail> => {
      const { slug } = slugParams.parse(request.params);
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) throw new HttpError(400, "Clé de licence : champs invalides.");
      const software = await softwareOf(slug);
      if (software.format !== TB1) throw new HttpError(400, `Format de licence non pris en charge : ${software.format}.`);
      // Ordre de la doc (6.3) : valider, normaliser, dates, identifiant, signer, chiffrer, insérer, journaliser.
      const entreprise = normalizeEntreprise(parsed.data.entreprise);
      if (!entreprise.ok) throw new HttpError(400, entreprise.reason, "entreprise");
      const emise = parisToday();
      const expire = expiryOf(emise, { months: parsed.data.months, expire: parsed.data.expire });
      if (!expire.ok) throw new HttpError(400, expire.reason, "duree");
      const contact = contactOf(parsed.data.contact);
      const erpClientId = parsed.data.erpClientId ?? null;
      if (erpClientId) await ensureErpClient(services, erpClientId);
      const key = await signingKey();
      if (!key) throw new HttpError(503, NO_SIGNING, "signing_unavailable");
      const id = randomBytes(12).toString("base64url");
      const cle = signTb1({ v: 1, id, entreprise: entreprise.value, emise, expire: expire.value }, key);
      const row = await prisma.license.create({
        data: {
          id,
          softwareId: software.id,
          entreprise: entreprise.value,
          erpClientId,
          contactEncrypted: encryptOptional(contact),
          keyEncrypted: encrypt(cle),
          emise,
          expire: expire.value,
          notes: notesOf(parsed.data.notes),
        },
      });
      await audit({ action: "licence.emettre", result: "ok", detail: `${software.slug} : ${entreprise.value}, expire le ${expire.value}` });
      reply.code(201);
      return detailOf(row, (await erpNames(services)).names, parisToday());
    });

    app.get("/api/logiciels/:slug/cles/:id", async (request): Promise<LicenseDetail> => {
      const { slug, id } = keyParams.parse(request.params);
      const software = await softwareOf(slug);
      const row = await prisma.license.findFirst({ where: { id, softwareId: software.id } });
      if (!row) throw new HttpError(404, "Clé introuvable.");
      return detailOf(row, (await erpNames(services)).names, parisToday());
    });

    app.patch("/api/logiciels/:slug/cles/:id", async (request): Promise<LicenseDetail> => {
      const { slug, id } = keyParams.parse(request.params);
      const parsed = updateSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw new HttpError(400, "Seuls les notes, le contact et le client de l'ERP se modifient : pour le nom ou la date, émettez une nouvelle clé.");
      const software = await softwareOf(slug);
      const row = await prisma.license.findFirst({ where: { id, softwareId: software.id } });
      if (!row) throw new HttpError(404, "Clé introuvable.");
      const data: { notes?: string | null; contactEncrypted?: string | null; erpClientId?: string | null } = {};
      if (parsed.data.notes !== undefined) data.notes = notesOf(parsed.data.notes);
      if (parsed.data.contact !== undefined) data.contactEncrypted = encryptOptional(contactOf(parsed.data.contact));
      if (parsed.data.erpClientId !== undefined) {
        if (parsed.data.erpClientId && parsed.data.erpClientId !== row.erpClientId) await ensureErpClient(services, parsed.data.erpClientId);
        data.erpClientId = parsed.data.erpClientId ?? null;
      }
      const updated = await prisma.license.update({ where: { id: row.id }, data });
      await audit({ action: "licence.modifier", result: "ok", detail: `${software.slug} : clé ${row.id}` });
      return detailOf(updated, (await erpNames(services)).names, parisToday());
    });
  };
}
