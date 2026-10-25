/** Plafonds des fichiers d'un site (limites Cloudflare Pages et du tunnel Cloudflare gratuit). */
export const MAX_FILES = 20_000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/**
 * Site PHP : pas de Cloudflare Pages, donc pas sa limite de 25 Mio par fichier. Les originaux d'images d'un
 * projet (photos de 48 Mpx) passent ; le total d'une version et d'un zip reste plafonné comme pour un site statique.
 */
export const MAX_PHP_FILE_BYTES = 256 * 1024 * 1024;
/** Taille maximale d'un fichier selon l'hébergement du site. */
export const maxFileBytesFor = (hosting: "pages" | "php" | undefined) => (hosting === "php" ? MAX_PHP_FILE_BYTES : MAX_FILE_BYTES);
/** Total d'une version de travail, et total décompressé d'un zip. */
export const MAX_SITE_BYTES = 500 * 1024 * 1024;
/** Fichiers par requête d'envoi (l'interface découpe un gros dossier en plusieurs envois). */
export const MAX_FILES_PER_UPLOAD = 1000;
/**
 * Parties multipart par requête : fichiers plus champs (« dir »). Sans ce réglage, busboy plafonne à 1 000
 * parties : 1 000 fichiers plus le champ « dir » dépassaient la limite (413, envoi d'un dossier refusé).
 */
export const MAX_PARTS_PER_UPLOAD = MAX_FILES_PER_UPLOAD + 10;
/** Envoi par morceaux (sessions) : taille d'un morceau, plafond d'un zip, durée de vie d'une session. */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_UPLOAD_ZIP_BYTES = 500 * 1024 * 1024;
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Sessions d'envoi ouvertes à la fois : par site et au total (reprises comprises). */
export const MAX_UPLOAD_SESSIONS_PER_SITE = 3;
export const MAX_UPLOAD_SESSIONS = 10;
/** Octets annoncés par l'ensemble des sessions ouvertes (place réservée sur le disque du hub). */
export const MAX_UPLOAD_PENDING_BYTES = 1024 * 1024 * 1024;
/** Place libre gardée sur le disque du hub après un envoi (base, blobs, sauvegardes). */
export const UPLOAD_DISK_MARGIN_BYTES = 512 * 1024 * 1024;
export const MAX_PATH_LENGTH = 1024;
export const MAX_SEGMENT_BYTES = 255;
export const MAX_DEPTH = 32;
/** Versions de contenu gardées par site (chez Cloudflare et sur le hub). */
export const KEPT_VERSIONS = 10;
export const PROJECTS_LIMIT = 100;
/** Image de vignette envoyée à la main. */
export const MAX_THUMBNAIL_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Limites annoncées à l'interface : le zip passe par les sessions d'envoi, d'où MAX_UPLOAD_ZIP_BYTES. */
export const FILE_LIMITS = { maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxZipBytes: MAX_UPLOAD_ZIP_BYTES };
