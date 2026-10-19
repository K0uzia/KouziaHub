import { prisma } from "@/lib/prisma.js";

export type AuditInput = {
  action: string;
  result: "ok" | "error";
  siteId?: string | null;
  siteSlug?: string | null;
  /** Texte court, sans secret (une connexion y note l'IP et l'appareil, jamais le mot de passe ni le code). */
  detail?: string | null;
};

/** Journal des actions : un échec d'écriture du journal ne fait jamais échouer l'action. */
export async function audit(input: AuditInput): Promise<void> {
  await prisma.auditEvent
    .create({
      data: {
        action: input.action,
        result: input.result,
        siteId: input.siteId ?? null,
        siteSlug: input.siteSlug ?? null,
        detail: input.detail ? input.detail.slice(0, 500) : null,
      },
    })
    .catch(() => undefined);
}
