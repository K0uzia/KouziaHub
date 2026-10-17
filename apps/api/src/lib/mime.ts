// Types de contenu des fichiers d'un site statique (envoi à Cloudflare et serveur de capture).
const TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
  json: "application/json",
  map: "application/json",
  webmanifest: "application/manifest+json",
  xml: "application/xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/vnd.microsoft.icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  mp4: "video/mp4",
  webm: "video/webm",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pdf: "application/pdf",
  zip: "application/zip",
  wasm: "application/wasm",
};

const TEXT = new Set(["text/html", "text/css", "application/javascript", "application/json", "application/xml", "text/plain", "text/markdown", "text/csv", "image/svg+xml", "application/manifest+json"]);

/** Extension sans le point, en minuscules (« » si aucune). */
export function extensionOf(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export function contentTypeOf(filePath: string): string {
  return TYPES[extensionOf(filePath)] ?? "application/octet-stream";
}

/** Type avec jeu de caractères pour les formats texte (serveur de capture). */
export function contentTypeWithCharset(filePath: string): string {
  const type = contentTypeOf(filePath);
  return TEXT.has(type) ? `${type}; charset=utf-8` : type;
}
