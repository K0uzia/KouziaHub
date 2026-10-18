import { z } from "zod";
import { checkReportField, type ReportSettings } from "@/contract.js";
import { HttpError } from "@/lib/http.js";
import { prisma } from "@/lib/prisma.js";

const KEYS: Record<keyof ReportSettings, string> = {
  displayName: "report.displayName",
  email: "report.email",
  phone: "report.phone",
  website: "report.website",
};
const FIELDS = Object.keys(KEYS) as Array<keyof ReportSettings>;

export async function getReportSettings(): Promise<ReportSettings> {
  const rows = await prisma.hubSetting.findMany({ where: { key: { in: Object.values(KEYS) } } });
  const get = (k: keyof ReportSettings) => rows.find((r) => r.key === KEYS[k])?.value || null;
  return { displayName: get("displayName"), email: get("email"), phone: get("phone"), website: get("website") };
}

/** Schéma zod d'un champ : vide ou null efface, sinon contrôle partagé avec le formulaire. */
const fieldSchema = (field: keyof ReportSettings) =>
  z
    .string()
    .max(300)
    .nullable()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined) return undefined;
      const checked = checkReportField(field, raw);
      if (checked.ok) return checked.value;
      ctx.addIssue({ code: "custom", message: checked.error });
      return z.NEVER;
    });

export const reportSettingsSchema = z
  .object({
    displayName: fieldSchema("displayName"),
    email: fieldSchema("email"),
    phone: fieldSchema("phone"),
    website: fieldSchema("website"),
  })
  .strict();

/** Valide une saisie ; erreur 400 "invalid_field" rattachée au premier champ en cause. */
export function parseReportSettings(body: unknown): Partial<Record<keyof ReportSettings, string | null>> {
  const parsed = reportSettingsSchema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues.find((i) => FIELDS.includes(i.path[0] as keyof ReportSettings) && i.code === "custom");
  if (issue) throw Object.assign(new HttpError(400, issue.message, "invalid_field"), { field: issue.path[0] as string });
  throw new HttpError(400, "Réglages invalides.");
}

export async function updateReportSettings(input: Partial<Record<keyof ReportSettings, string | null>>): Promise<ReportSettings> {
  const changes = FIELDS.filter((f) => input[f] !== undefined).map((f) => [f, input[f] ?? null] as const);
  await prisma.$transaction(
    changes.map(([field, value]) =>
      value === null
        ? prisma.hubSetting.deleteMany({ where: { key: KEYS[field] } })
        : prisma.hubSetting.upsert({ where: { key: KEYS[field] }, create: { key: KEYS[field], value }, update: { value } }),
    ),
  );
  return getReportSettings();
}
