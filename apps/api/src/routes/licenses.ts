import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { Prisma, type License, type Software } from "@prisma/client";
import { z } from "zod";
import {
  checkSoftwareField,
  type LicenseDetail,
  type LicenseSummary,
  type SoftwareCatalog,
  type SoftwareDetail,
  type SoftwareField,
  type SoftwareSummary,
} from "@/contract.js";
import { audit } from "@/lib/audit.js";
import { requireAuth } from "@/lib/auth.js";
import { decrypt, decryptOptional, encrypt, encryptOptional } from "@/lib/crypto.js";
import { ERP_CLIENT_ID, ErpUnavailableError } from "@/lib/erp/types.js";
import { HttpError } from "@/lib/http.js";
import { routeParam } from "@/lib/http-input.js";
import { MAX_THUMBNAIL_UPLOAD_BYTES } from "@/lib/limits.js";
import { KZ1, signKz1 } from "@/lib/licenses/kz1.js";
import { expiryOf, licenseStatus, normalizeEntreprise, parisToday, signTb1, TB1 } from "@/lib/licenses/tb1.js";
import { publicPemOf, signingKey } from "@/lib/licenses/signer.js";
import { prisma } from "@/lib/prisma.js";
import type { Services } from "@/lib/services.js";
import { erpNames } from "@/lib/site-view.js";
import { toThumbnail } from "@/lib/thumbnails.js";

// Page Logiciels : fiches et registre des clés de licence (docs/licences-logiciels.md, sections 5 et 6). Le hub signe,
// chaque logiciel vérifie hors ligne. Pas de révocation : changer le nom ou la date, c'est émettre une nouvelle clé.
// Tracebay garde son format TB1 ; les logiciels ajoutés depuis l'interface signent en KZ1 avec leur propre paire.

const TRACEBAY = { slug: "tracebay", name: "Tracebay", format: TB1, keyPrefix: TB1 };
const NO_SIGNING = "Émission impossible : la clé de signature est absente sur le serveur.";

const slugParams = z.object({ slug: routeParam });
const keyParams = z.object({ slug: routeParam, id: routeParam });
const erpId = z.string().regex(ERP_CLIENT_ID).nullable().optional();
const text = (max: number) => z.string().max(max).nullable().optional();
const createSchema = z
  .object({
    entreprise: z.string().max(1000),
    erpClientId: erpId,
    contact: text(1000),
    notes: text(2000),
    months: z.number().int().optional(),
    expire: z.string().max(10).optional(),
  })
  .strict();
const updateSchema = z.object({ notes: text(2000), contact: text(1000), erpClientId: erpId }).strict();
const softwareCreateSchema = z
  .object({ name: z.string().max(1000), slug: z.string().max(100), keyPrefix: z.string().max(100), description: text(5000), demoUrl: text(2000), releasesUrl: text(2000) })
  .strict();
const softwareUpdateSchema = z.object({ name: z.string().max(1000).optional(), description: text(5000), demoUrl: text(2000), releasesUrl: text(2000) }).strict();

/** Champ contrôlé par la règle partagée avec le formulaire ; 400 avec le champ en code. */
function field(name: SoftwareField, raw: string | null | undefined): string | null {
  const checked = checkSoftwareField(name, raw);
  if (!checked.ok) throw new HttpError(400, checked.error, name);
  return checked.value;
}

/** Tracebay créé au premier besoin (préfixe posé s'il manque), sans rien changer d'autre. */
async function ensureTracebay(): Promise<void> {
  await prisma.software.upsert({ where: { slug: TRACEBAY.slug }, create: TRACEBAY, update: {} });
  await prisma.software.updateMany({ where: { slug: TRACEBAY.slug, keyPrefix: null }, data: { keyPrefix: TB1 } });
}

/** Logiciel connu, 404 sinon. */
async function softwareOf(slug: string): Promise<Software> {
  await ensureTracebay();
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

async function softwareSummary(software: Software, today: string, signing: boolean): Promise<SoftwareSummary> {
  const rows = await prisma.license.findMany({ where: { softwareId: software.id }, select: { expire: true, entreprise: true } });
  const counts = { active: 0, expiring: 0, expired: 0 };
  let next: { expire: string; entreprise: string } | null = null;
  for (const r of rows) {
    const status = licenseStatus(r.expire, today);
    counts[status]++;
    if (status !== "expired" && (!next || r.expire < next.expire || (r.expire === next.expire && r.entreprise.localeCompare(next.entreprise, "fr") < 0))) {
      next = { expire: r.expire, entreprise: r.entreprise };
    }
  }
  return {
    slug: software.slug,
    name: software.name,
    format: software.format,
    keyPrefix: software.keyPrefix ?? software.format,
    description: software.description,
    demoUrl: software.demoUrl,
    releasesUrl: software.releasesUrl,
    thumbnailUrl: software.thumbnailPath ? `/api/logiciels/${software.slug}/vignette?v=${software.thumbnailAt?.getTime() ?? 0}` : null,
    signing,
    counts,
    nextExpiry: next,
  };
}

async function softwareDetail(services: Services, software: Software): Promise<SoftwareDetail> {
  const today = parisToday();
  const [rows, erp, key] = await Promise.all([
    prisma.license.findMany({ where: { softwareId: software.id } }),
    erpNames(services),
    signingKey(software.slug),
  ]);
  const licenses = rows
    .map((r) => summaryOf(r, erp.names, today))
    .sort((a, b) => a.expire.localeCompare(b.expire) || a.entreprise.localeCompare(b.entreprise, "fr"));
  return { software: await softwareSummary(software, today, key !== null), signing: key !== null, publicKey: key ? publicPemOf(key) : null, today, licenses };
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
  const thumbDir = path.join(services.dataDir, "thumbnails");

  return async (app) => {
    app.addHook("onRequest", requireAuth);

    // --- Logiciels ---

    app.get("/api/logiciels", async (): Promise<SoftwareCatalog> => {
      await ensureTracebay();
      const today = parisToday();
      const all = await prisma.software.findMany({ orderBy: { name: "asc" } });
      const software = await Promise.all(all.map(async (s) => softwareSummary(s, today, (await signingKey(s.slug)) !== null)));
      return { software, today };
    });

    app.post("/api/logiciels", async (request, reply): Promise<SoftwareDetail> => {
      const parsed = softwareCreateSchema.safeParse(request.body);
      if (!parsed.success) throw new HttpError(400, "Logiciel : champs invalides.");
      const data = {
        name: field("name", parsed.data.name)!,
        slug: field("slug", parsed.data.slug)!,
        keyPrefix: field("keyPrefix", parsed.data.keyPrefix)!,
        description: field("description", parsed.data.description),
        demoUrl: field("demoUrl", parsed.data.demoUrl),
        releasesUrl: field("releasesUrl", parsed.data.releasesUrl),
      };
      await ensureTracebay();
      if (await prisma.software.findUnique({ where: { slug: data.slug } })) throw new HttpError(409, `L'identifiant ${data.slug} est déjà pris.`, "slug");
      if (await prisma.software.findUnique({ where: { keyPrefix: data.keyPrefix } })) throw new HttpError(409, `Le préfixe ${data.keyPrefix} est déjà pris.`, "keyPrefix");
      let software: Software;
      try {
        software = await prisma.software.create({ data: { ...data, format: KZ1 } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new HttpError(409, "Identifiant ou préfixe déjà pris.", "slug");
        throw err;
      }
      await audit({ action: "logiciel.creer", result: "ok", detail: `${software.slug} : ${software.name}, préfixe ${data.keyPrefix}` });
      reply.code(201);
      return softwareDetail(services, software);
    });

    app.get("/api/logiciels/:slug", async (request): Promise<SoftwareDetail> => {
      const { slug } = slugParams.parse(request.params);
      return softwareDetail(services, await softwareOf(slug));
    });

    app.patch("/api/logiciels/:slug", async (request): Promise<SoftwareDetail> => {
      const { slug } = slugParams.parse(request.params);
      const parsed = softwareUpdateSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw new HttpError(400, "Seuls le nom, la description et les liens se modifient : l'identifiant et le préfixe sont dans les clés émises.");
      const software = await softwareOf(slug);
      const data: Prisma.SoftwareUpdateInput = {};
      if (parsed.data.name !== undefined) data.name = field("name", parsed.data.name)!;
      if (parsed.data.description !== undefined) data.description = field("description", parsed.data.description);
      if (parsed.data.demoUrl !== undefined) data.demoUrl = field("demoUrl", parsed.data.demoUrl);
      if (parsed.data.releasesUrl !== undefined) data.releasesUrl = field("releasesUrl", parsed.data.releasesUrl);
      const updated = await prisma.software.update({ where: { id: software.id }, data });
      await audit({ action: "logiciel.modifier", result: "ok", detail: `${software.slug} : ${Object.keys(data).join(", ") || "aucun champ"}` });
      return softwareDetail(services, updated);
    });

    app.delete("/api/logiciels/:slug", async (request, reply) => {
      const { slug } = slugParams.parse(request.params);
      const software = await softwareOf(slug);
      if (software.slug === TRACEBAY.slug) throw new HttpError(409, "Tracebay ne se supprime pas.", "tracebay");
      // Registre : une clé émise reste consultable tant que le logiciel existe.
      if (await prisma.license.count({ where: { softwareId: software.id } })) throw new HttpError(409, "Des clés ont été émises pour ce logiciel : il reste au registre.", "licenses");
      await prisma.software.delete({ where: { id: software.id } });
      if (software.thumbnailPath) await rm(path.join(services.dataDir, software.thumbnailPath), { force: true });
      await audit({ action: "logiciel.supprimer", result: "ok", detail: `${software.slug} : ${software.name}` });
      return reply.code(204).send();
    });

    // --- Vignette (envoi seulement : la capture du hub ne joint aucun réseau extérieur) ---

    app.get("/api/logiciels/:slug/vignette", async (request, reply) => {
      const { slug } = slugParams.parse(request.params);
      const software = await softwareOf(slug);
      if (!software.thumbnailPath) throw new HttpError(404, "Pas de vignette.");
      const file = path.join(services.dataDir, software.thumbnailPath);
      const info = await stat(file).catch(() => null);
      if (!info) throw new HttpError(404, "Pas de vignette.");
      return reply
        .header("Content-Type", "image/webp")
        .header("Content-Length", String(info.size))
        .header("Cache-Control", "private, max-age=86400")
        .send(createReadStream(file));
    });

    app.post("/api/logiciels/:slug/vignette", async (request): Promise<SoftwareDetail> => {
      const { slug } = slugParams.parse(request.params);
      const software = await softwareOf(slug);
      if (!request.isMultipart()) throw new HttpError(400, "Envoi multipart attendu.");
      const part = await request.file({ limits: { fileSize: MAX_THUMBNAIL_UPLOAD_BYTES, files: 1 }, throwFileSizeLimit: false });
      if (!part) throw new HttpError(400, "Image attendue.");
      if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(part.mimetype)) {
        part.file.resume();
        throw new HttpError(400, "Formats acceptés : PNG, JPEG, WebP, GIF ou AVIF.");
      }
      const buffer = await part.toBuffer();
      if (part.file.truncated) throw new HttpError(413, `Image trop lourde : ${MAX_THUMBNAIL_UPLOAD_BYTES / 1024 / 1024} Mio au plus.`);
      let image: Buffer;
      try {
        image = await toThumbnail(buffer);
      } catch {
        throw new HttpError(400, "Image illisible.");
      }
      // Nom tiré de l'id (stable, sans caractère libre), écrit puis renommé : jamais de fichier à moitié écrit.
      const name = `software-${software.id}.webp`;
      await mkdir(thumbDir, { recursive: true });
      await writeFile(path.join(thumbDir, `${name}.tmp`), image);
      await rename(path.join(thumbDir, `${name}.tmp`), path.join(thumbDir, name));
      const updated = await prisma.software.update({ where: { id: software.id }, data: { thumbnailPath: `thumbnails/${name}`, thumbnailAt: new Date() } });
      await audit({ action: "logiciel.vignette", result: "ok", detail: `${software.slug} : image envoyée` });
      return softwareDetail(services, updated);
    });

    app.delete("/api/logiciels/:slug/vignette", async (request): Promise<SoftwareDetail> => {
      const { slug } = slugParams.parse(request.params);
      const software = await softwareOf(slug);
      if (software.thumbnailPath) await rm(path.join(services.dataDir, software.thumbnailPath), { force: true });
      const updated = await prisma.software.update({ where: { id: software.id }, data: { thumbnailPath: null, thumbnailAt: null } });
      await audit({ action: "logiciel.vignette", result: "ok", detail: `${software.slug} : image retirée` });
      return softwareDetail(services, updated);
    });

    // --- Clés de licence ---

    app.post("/api/logiciels/:slug/cles", async (request, reply): Promise<LicenseDetail> => {
      const { slug } = slugParams.parse(request.params);
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) throw new HttpError(400, "Clé de licence : champs invalides.");
      const software = await softwareOf(slug);
      if (software.format !== TB1 && software.format !== KZ1) throw new HttpError(400, `Format de licence non pris en charge : ${software.format}.`);
      // Ordre de la doc (6.3) : valider, normaliser, dates, identifiant, signer, chiffrer, insérer, journaliser.
      const entreprise = normalizeEntreprise(parsed.data.entreprise);
      if (!entreprise.ok) throw new HttpError(400, entreprise.reason, "entreprise");
      const emise = parisToday();
      const expire = expiryOf(emise, { months: parsed.data.months, expire: parsed.data.expire });
      if (!expire.ok) throw new HttpError(400, expire.reason, "duree");
      const contact = contactOf(parsed.data.contact);
      const erpClientId = parsed.data.erpClientId ?? null;
      if (erpClientId) await ensureErpClient(services, erpClientId);
      const key = await signingKey(software.slug);
      if (!key) throw new HttpError(503, NO_SIGNING, "signing_unavailable");
      const id = randomBytes(12).toString("base64url");
      const signed = { v: 1 as const, id, entreprise: entreprise.value, emise, expire: expire.value };
      const cle = software.format === TB1 ? signTb1(signed, key) : signKz1(software.keyPrefix!, { ...signed, logiciel: software.slug }, key);
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
