// Premier .env de dev : copie de .env.example avec des secrets aléatoires propres à ce PC,
// la vérification Access coupée et les adaptateurs factices (aucun jeton Cloudflare, aucun ERP).
// Ne touche jamais un .env existant.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, ".env");
mkdirSync(path.join(root, "data"), { recursive: true });
if (existsSync(target)) {
  console.log(".env déjà présent : inchangé.");
  process.exit(0);
}

const values = {
  DATABASE_URL: "file:../data/hub.db",
  SESSION_SECRET: randomBytes(32).toString("base64url"),
  ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  WEB_ORIGIN: "http://localhost:5174",
  CF_ACCESS_DISABLED: "true",
};

const lines = readFileSync(path.join(root, ".env.example"), "utf8")
  .split(/\r?\n/)
  .map((line) => {
    const m = /^([A-Z0-9_]+)=$/.exec(line);
    return m && m[1] in values ? `${m[1]}=${values[m[1]]}` : line;
  });
writeFileSync(target, lines.join("\n"), { mode: 0o600 });
console.log(".env de dev créé (secrets aléatoires, Access coupé, Cloudflare et ERP factices).");
