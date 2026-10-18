// Variables de test posées avant l'import des modules (Prisma lit DATABASE_URL à l'instanciation).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "file:./test.db";
process.env.SESSION_SECRET ??= "test-session-secret-32chars-min";
process.env.ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.WEB_ORIGIN ??= "http://localhost:5174";
process.env.CF_ACCESS_DISABLED = "true";
// Aucun appel réseau en test : adaptateurs factices, données dans un dossier temporaire.
delete process.env.CLOUDFLARE_API_TOKEN;
delete process.env.ERP_BASE_URL;
for (const key of ["MONITOR_WORKER_URL", "MONITOR_SHARED_SECRET", "CLOUDFLARE_ZONES_READ_TOKEN", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) {
  delete process.env[key];
}
process.env.HUB_DATA_DIR = mkdtempSync(join(tmpdir(), "kouzia-hub-test-"));
