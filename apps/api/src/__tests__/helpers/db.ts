import { prisma } from "@/lib/prisma.js";

// Ordre enfants puis parents (clés étrangères SQLite).
const TABLES = [
  "MonitorCheck",
  "MonitorHourly",
  "MonitorIncident",
  "MonitorAlert",
  "MonitorReport",
  "MonitorTarget",
  "PushSubscription",
  "VersionFile",
  "Version",
  "WorkingFile",
  "Operation",
  "Site",
  "AuditEvent",
  "OrphanCheck",
  "Session",
  "AdminRecoveryCode",
  "AdminLoginChallenge",
  "HubSetting",
  "User",
] as const;

/** Vide toutes les tables. */
export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys = OFF");
  try {
    for (const t of TABLES) {
      await (prisma as unknown as Record<string, { deleteMany: () => Promise<unknown> }>)[
        t.charAt(0).toLowerCase() + t.slice(1)
      ]!.deleteMany();
    }
  } finally {
    await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON");
  }
}

export { prisma };
