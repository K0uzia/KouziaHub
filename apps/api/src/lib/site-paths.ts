// Import relatif : ce module est aussi utilisé par l'interface (alias @hub/site-paths), qui écarte les mêmes fichiers
// avant l'envoi. Il ne dépend que de limits.ts, sans code serveur.
import { MAX_DEPTH, MAX_FILE_BYTES, MAX_PATH_LENGTH, MAX_SEGMENT_BYTES } from "./limits.js";

const MIB = 1024 * 1024;
// TextEncoder plutôt que Buffer : le module tourne aussi dans le navigateur.
const utf8 = new TextEncoder();

/** Raison d'un fichier trop lourd pour Cloudflare Pages : taille, limite et conduite à tenir. */
export function fileTooBigReason(size: number): string {
  const mib = (size / MIB).toFixed(1).replace(".", ",");
  return `Fichier de ${mib} Mio : au-delà de ${MAX_FILE_BYTES / MIB} Mio, la limite de Cloudflare Pages par fichier. Réduisez-le ou retirez-le.`;
}

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
    if (utf8.encode(segment).length > MAX_SEGMENT_BYTES) return { ok: false, reason: "Nom de fichier trop long." };
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

/**
 * Dossiers de développement jamais envoyés (dépendances, dépôt Git, caches des générateurs et des hébergeurs) :
 * refusés par le serveur, écartés par l'interface avant l'envoi. En minuscules.
 */
export const DEV_DIRECTORIES: readonly string[] = [
  "node_modules",
  ".git",
  ".astro",
  ".cache",
  ".vercel",
  ".netlify",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".idea",
  ".vscode",
];
const DEV_DIRECTORY_SET = new Set(DEV_DIRECTORIES);

/** Premier dossier de développement d'un chemin (« node_modules »…), null s'il n'y en a pas. */
export function devDirectoryOf(sitePath: string): string | null {
  const segments = sitePath.split("/");
  for (const segment of segments) {
    if (DEV_DIRECTORY_SET.has(segment.toLowerCase())) return segment;
  }
  return null;
}

/**
 * Fichiers d'outillage d'un projet (manifeste, verrous, configuration de build, conteneurs) : rien à faire dans
 * un site construit, et lisibles par tous s'ils sont servis (ex. package.json resté d'un ancien envoi). Refusés à
 * l'envoi (interface et serveur) et en 403 par le _worker.js, sauf exception posée par site (onglet Serveur).
 * Données : le _worker.js applique les mêmes, une seule source.
 */
export const DEV_TOOLING = {
  /** Noms refusés partout (minuscules). */
  names: [
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "jsconfig.json",
    ".npmrc",
    ".nvmrc",
    ".node-version",
    ".editorconfig",
    "dockerfile",
    "makefile",
  ],
  /** Motifs de nom refusés partout (expressions, insensibles à la casse). */
  patterns: ["^tsconfig[^/]*\\.json$", "^docker-compose[^/]*\\.ya?ml$", "^(?:vite|astro|next|nuxt|svelte)\\.config\\.[a-z]+$"],
  /** Motifs refusés à la racine seulement (configuration d'outils : tailwind.config.js, eslint.config.mjs...). */
  rootPatterns: ["^[^/]+\\.config\\.(?:js|ts|mjs|cjs|mts|cts)$"],
  /** Dossiers de sources refusés à la racine. */
  rootDirs: ["src"],
} as const;

/** Exception d'un site : chemin exact seulement (ni dossier, ni joker). */
export function isAllowedPath(sitePath: string, allow: readonly string[] | undefined): boolean {
  return allow?.includes(sitePath) ?? false;
}

/** Élément d'outillage d'un chemin (« package.json », « src/ »...), null s'il n'y en a pas. */
export function devToolingOf(sitePath: string): string | null {
  const segments = sitePath.split("/");
  const base = segments[segments.length - 1]!;
  const lowerBase = base.toLowerCase();
  if ((DEV_TOOLING.names as readonly string[]).includes(lowerBase)) return base;
  if (DEV_TOOLING.patterns.some((p) => new RegExp(p, "i").test(base))) return base;
  if (segments.length === 1 && DEV_TOOLING.rootPatterns.some((p) => new RegExp(p, "i").test(base))) return base;
  if (segments.length > 1 && (DEV_TOOLING.rootDirs as readonly string[]).includes(segments[0]!.toLowerCase())) return `${segments[0]}/`;
  return null;
}

export type ClassifyOptions = {
  /** Exceptions du site aux fichiers d'outillage (jamais aux .env, .git, dossiers de développement, _worker.js). */
  allow?: readonly string[];
};

/** Tri d'un chemin déjà normalisé : accepté, refusé (montré avec sa raison) ou écarté sans bruit. */
export function classifySitePath(sitePath: string, options: ClassifyOptions = {}): Classification {
  const segments = sitePath.split("/");
  const base = segments[segments.length - 1]!;
  const lowerBase = base.toLowerCase();
  const lowerSegments = segments.map((s) => s.toLowerCase());

  if (lowerSegments.includes("__macosx") || IGNORED_NAMES.has(lowerBase)) {
    return { action: "ignore", reason: "Fichier système écarté." };
  }
  // Premier segment, fichier ou dossier : Pages exécute aussi un dossier _worker.js/ (index.js) à la racine.
  if (lowerSegments[0] === "_worker.js") {
    return { action: "reject", reason: "_worker.js refusé : seul le hub injecte du code exécuté par Cloudflare." };
  }
  if (lowerSegments[0] === "_routes.json") {
    return { action: "reject", reason: "_routes.json refusé : seul le hub règle le routage Cloudflare." };
  }
  if (segments.length > 1 && lowerSegments[0] === "functions") {
    return { action: "reject", reason: "Dossier functions/ refusé : seul le hub injecte du code exécuté par Cloudflare." };
  }
  const devDir = devDirectoryOf(sitePath);
  if (devDir) return { action: "reject", reason: `Dossier ${devDir} refusé (fichiers de développement).` };
  if (lowerSegments.some((s) => s === ".env" || s.startsWith(".env."))) {
    return { action: "reject", reason: "Fichier .env refusé (secrets possibles)." };
  }
  if (lowerBase.endsWith(".map")) return { action: "reject", reason: "Carte de sources (.map) refusée : elle exposerait le code source." };
  if (lowerBase.endsWith(".bak") || lowerBase.endsWith("~") || lowerBase.endsWith(".swp") || lowerBase.endsWith(".swo")) {
    return { action: "reject", reason: "Fichier de sauvegarde refusé." };
  }
  const tooling = devToolingOf(sitePath);
  if (tooling && !isAllowedPath(sitePath, options.allow)) {
    return tooling.endsWith("/")
      ? { action: "reject", reason: `Dossier ${tooling} refusé (sources du projet, inutiles dans un site construit ; exception possible dans l'onglet Serveur).` }
      : { action: "reject", reason: `Fichier de développement refusé (${tooling}) : inutile dans un site construit (exception possible dans l'onglet Serveur).` };
  }
  return { action: "accept" };
}

/** Normalisation puis tri : la raison du refus est toujours renvoyée en français. */
export function checkSitePath(raw: string, options: ClassifyOptions = {}): { path: string; verdict: Classification } {
  const normalized = normalizeSitePath(raw);
  if (!normalized.ok) return { path: raw, verdict: { action: "reject", reason: normalized.reason } };
  return { path: normalized.path, verdict: classifySitePath(normalized.path, options) };
}

/** Fichiers envoyés à Cloudflare comme champs dédiés du déploiement, pas comme fichiers servis. */
export const CONFIG_FILES = new Set(["_headers", "_redirects"]);
