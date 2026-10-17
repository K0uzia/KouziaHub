/** Plafonds des fichiers d'un site (limites Cloudflare Pages et du tunnel Cloudflare gratuit). */
export const MAX_FILES = 20_000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Corps de requête limité à 100 Mo par le tunnel : le zip reste en dessous, marge pour l'enveloppe multipart. */
export const MAX_ZIP_BYTES = 95 * 1024 * 1024;
/** Total d'une version de travail, et total décompressé d'un zip. */
export const MAX_SITE_BYTES = 500 * 1024 * 1024;
/** Fichiers par requête d'envoi (l'interface découpe un gros dossier en plusieurs envois). */
export const MAX_FILES_PER_UPLOAD = 1000;
export const MAX_PATH_LENGTH = 1024;
export const MAX_SEGMENT_BYTES = 255;
export const MAX_DEPTH = 32;
/** Versions de contenu gardées par site (chez Cloudflare et sur le hub). */
export const KEPT_VERSIONS = 10;
export const PROJECTS_LIMIT = 100;
/** Image de vignette envoyée à la main. */
export const MAX_THUMBNAIL_UPLOAD_BYTES = 10 * 1024 * 1024;

export const FILE_LIMITS = { maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxZipBytes: MAX_ZIP_BYTES };
