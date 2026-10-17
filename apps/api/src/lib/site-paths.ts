import { MAX_DEPTH, MAX_PATH_LENGTH, MAX_SEGMENT_BYTES } from "@/lib/limits.js";

export type PathResult = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Chemin d'un fichier de site : NFC, séparateur « / », sans « / » initial ni segment vide, « . » ou « .. ».
 * Refuse plutôt que corriger : un chemin douteux est un envoi piégé ou une erreur à montrer.
 */
export function normalizeSitePath(raw: string): PathResult {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "Chemin vide." };
  const value = raw.normalize("NFC");
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, reason: "Caractère de contrôle interdit dans le nom." };
  if (value.includes("\\")) return { ok: false, reason: "Antislash interdit dans un chemin (utiliser « / »)." };
  if (/^[a-zA-Z]:/.test(value)) return { ok: false, reason: "Chemin absolu refusé (lettre de lecteur)." };
  if (value.startsWith("/")) return { ok: false, reason: "Chemin absolu refusé." };
  if (value.length > MAX_PATH_LENGTH) return { ok: false, reason: "Chemin trop long." };
  const segments = value.split("/");
  if (segments.length > MAX_DEPTH) return { ok: false, reason: "Arborescence trop profonde." };
  for (const segment of segments) {
    if (segment === "..") return { ok: false, reason: "« .. » interdit dans un chemin." };
    if (segment === "" || segment === ".") return { ok: false, reason: "Chemin invalide (segment vide ou « . »)." };
    if (Buffer.byteLength(segment, "utf8") > MAX_SEGMENT_BYTES) return { ok: false, reason: "Nom de fichier trop long." };
  }
  return { ok: true, path: value };
}

/** Dossier cible : vide pour la racine, sinon chemin normalisé sans « / » final. */
export function normalizeDir(raw: string | undefined | null): PathResult {
  const trimmed = (raw ?? "").replace(/\/+$/, "");
  if (trimmed === "") return { ok: true, path: "" };
  return normalizeSitePath(trimmed);
}

export type Classification = { action: "accept" } | { action: "reject"; reason: string } | { action: "ignore"; reason: string };

const IGNORED_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

/** Tri d'un chemin déjà normalisé : accepté, refusé (montré avec sa raison) ou écarté sans bruit. */
export function classifySitePath(sitePath: string): Classification {
  const segments = sitePath.split("/");
  const base = segments[segments.length - 1]!;
  const lowerBase = base.toLowerCase();
  const lowerSegments = segments.map((s) => s.toLowerCase());

  if (lowerSegments.includes("__macosx") || IGNORED_NAMES.has(lowerBase)) {
    return { action: "ignore", reason: "Fichier système écarté." };
  }
  if (segments.length === 1 && lowerBase === "_worker.js") {
    return { action: "reject", reason: "_worker.js refusé : seul le hub injecte du code exécuté par Cloudflare." };
  }
  if (segments.length === 1 && lowerBase === "_routes.json") {
    return { action: "reject", reason: "_routes.json refusé : seul le hub règle le routage Cloudflare." };
  }
  if (segments.length > 1 && lowerSegments[0] === "functions") {
    return { action: "reject", reason: "Dossier functions/ refusé : seul le hub injecte du code exécuté par Cloudflare." };
  }
  if (lowerSegments.includes(".git")) return { action: "reject", reason: "Dossier .git refusé (fichiers de développement)." };
  if (lowerSegments.includes("node_modules")) return { action: "reject", reason: "Dossier node_modules refusé (fichiers de développement)." };
  if (lowerSegments.some((s) => s === ".env" || s.startsWith(".env."))) {
    return { action: "reject", reason: "Fichier .env refusé (secrets possibles)." };
  }
  if (lowerBase.endsWith(".map")) return { action: "reject", reason: "Carte de sources (.map) refusée : elle exposerait le code source." };
  if (lowerBase.endsWith(".bak") || lowerBase.endsWith("~") || lowerBase.endsWith(".swp") || lowerBase.endsWith(".swo")) {
    return { action: "reject", reason: "Fichier de sauvegarde refusé." };
  }
  return { action: "accept" };
}

/** Normalisation puis tri : la raison du refus est toujours renvoyée en français. */
export function checkSitePath(raw: string): { path: string; verdict: Classification } {
  const normalized = normalizeSitePath(raw);
  if (!normalized.ok) return { path: raw, verdict: { action: "reject", reason: normalized.reason } };
  return { path: normalized.path, verdict: classifySitePath(normalized.path) };
}

/** Fichiers envoyés à Cloudflare comme champs dédiés du déploiement, pas comme fichiers servis. */
export const CONFIG_FILES = new Set(["_headers", "_redirects"]);
