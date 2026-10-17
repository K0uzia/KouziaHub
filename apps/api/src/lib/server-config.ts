// Configuration serveur d'un site, générée depuis une seule source : son profil.
// - .htaccess (Apache, LiteSpeed chez Hostinger) : écrit dans la version de travail, modifiable.
// - Cloudflare Pages (.htaccess ignoré) : _headers et règles de cache du _worker.js, au déploiement.
// Fonctions pures : aucun accès à la base ni aux fichiers.

export type CanonicalHost = "www" | "apex";

export type ServerProfile = {
  /** Domaine final sans « www. » (ex. « client.fr »), null tant qu'il n'est pas connu. */
  finalDomain: string | null;
  canonicalHost: CanonicalHost;
  /** Chemin depuis la racine (ex. « /404.html »). */
  notFoundPage: string;
};

export const HTACCESS_PATH = ".htaccess";
export const DEFAULT_NOT_FOUND = "/404.html";
export const GENERATED_MARKER = "# Généré par le hub Kouzia.";

/**
 * Règles de cache (règle web-perf-eco), source unique du .htaccess, du _headers et du _worker.js.
 * Ordre : la première règle qui correspond s'applique.
 */
export const CACHE_RULES: ReadonlyArray<{ label: string; pattern: string; cacheControl: string; pagesPaths: string[] }> = [
  {
    label: "Fichiers au nom hashé (Vite /assets/, Astro /_astro/) : 1 an, immuables",
    pattern: "\\.[0-9a-zA-Z_-]{8,}\\.(?:css|js|mjs|woff2?|webp|avif|svg|png|jpe?g|gif)$",
    cacheControl: "public, max-age=31536000, immutable",
    pagesPaths: ["/assets/*", "/_astro/*"],
  },
  { label: "Polices : 1 an", pattern: "\\.(?:woff2?|ttf|otf)$", cacheControl: "public, max-age=31536000", pagesPaths: [] },
  { label: "CSS et JS non hashés : 7 jours", pattern: "\\.(?:css|m?js)$", cacheControl: "public, max-age=604800", pagesPaths: [] },
  {
    label: "Images : 30 jours",
    pattern: "\\.(?:png|jpe?g|gif|webp|avif|svg|ico)$",
    cacheControl: "public, max-age=2592000",
    pagesPaths: [],
  },
  { label: "HTML : court (toujours revalidé)", pattern: "(?:\\.html?|/[^/.]*)$", cacheControl: "public, max-age=0, must-revalidate", pagesPaths: [] },
];

/** CSP par défaut d'un site statique client : raisonnable, à élargir service par service. */
export const DEFAULT_CSP =
  "default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'self'; " +
  "script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; " +
  "connect-src 'self'; upgrade-insecure-requests";

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Domaine final : nom d'hôte seul, minuscules, « www. » retiré (la forme canonique le rajoute). */
export function normalizeFinalDomain(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const value = raw.trim().toLowerCase().replace(/\.$/, "");
  if (/^[a-z]+:\/\//.test(value) || value.includes("/")) return { ok: false, reason: "Nom de domaine seul, sans « https:// » ni chemin." };
  const domain = value.startsWith("www.") ? value.slice(4) : value;
  if (!HOSTNAME.test(domain)) return { ok: false, reason: "Nom de domaine invalide." };
  return { ok: true, value: domain };
}

/** Page 404 : « / » initial, fichier .html, chemin sans « .. » ni caractère douteux. */
export function notFoundPageError(value: string): string | null {
  const segments = value.slice(1).split("/");
  const valid =
    /^\/[A-Za-z0-9._/-]{1,200}\.html$/.test(value) && segments.every((s) => s !== "" && !s.startsWith("."));
  return valid ? null : "Chemin de page 404 invalide (ex. /404.html).";
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** .htaccess complet. Tout est sous IfModule : un module absent n'empêche jamais le site de répondre. */
export function buildHtaccess(profile: ServerProfile): string {
  const lines: string[] = [];
  const add = (...l: string[]) => lines.push(...l);
  add(
    `${GENERATED_MARKER} Modifiable : le hub ne l'écrase plus s'il est modifié à la main`,
    "# (régénération seulement sur confirmation, depuis la fiche du site).",
    "# Source : profil du site (domaine final, forme canonique, page 404) dans le hub.",
    "",
    "# Listing des dossiers coupé (AllowOverride Options requis, autorisé chez Hostinger).",
    "Options -Indexes -MultiViews",
    "ServerSignature Off",
    "DirectoryIndex index.html",
    `ErrorDocument 404 ${profile.notFoundPage}`,
    "",
    "<IfModule mod_rewrite.c>",
    "    RewriteEngine On",
    "",
  );

  const domain = profile.finalDomain;
  if (domain) {
    const canonical = profile.canonicalHost === "www" ? `www.${domain}` : domain;
    const other = profile.canonicalHost === "www" ? domain : `www.${domain}`;
    add(
      `    # Forme canonique : https://${canonical}`,
      `    RewriteCond %{HTTP_HOST} ^${escapeRegex(other)}$ [NC]`,
      `    RewriteRule ^ https://${canonical}%{REQUEST_URI} [R=301,L,NE]`,
      "",
      "    # HTTPS (X-Forwarded-Proto : derrière un proxy en HTTP, pas de boucle)",
      "    RewriteCond %{HTTPS} !=on",
      "    RewriteCond %{HTTP:X-Forwarded-Proto} !=https",
      `    RewriteCond %{HTTP_HOST} ^(www\\.)?${escapeRegex(domain)}$ [NC]`,
      `    RewriteRule ^ https://${canonical}%{REQUEST_URI} [R=301,L,NE]`,
    );
  } else {
    add(
      "    # Domaine final pas encore renseigné dans le hub : aucune redirection d'hôte (www ou non).",
      "    # HTTPS (X-Forwarded-Proto : derrière un proxy en HTTP, pas de boucle)",
      "    RewriteCond %{HTTPS} !=on",
      "    RewriteCond %{HTTP:X-Forwarded-Proto} !=https",
      "    RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L,NE]",
    );
  }
  add(
    "",
    "    # Une seule URL par page : /index.html vers / (THE_REQUEST : fiable sous LiteSpeed)",
    "    RewriteCond %{THE_REQUEST} \\s/+((?:[^\\s?]*/)?)index\\.html[\\s?] [NC]",
    "    RewriteRule ^ /%1 [R=301,L,NE]",
    "",
    "    # Fichiers cachés (.git, .env...) refusés, sauf /.well-known/",
    "    RewriteRule (^|/)\\.(?!well-known/) - [F,L]",
    "    RewriteRule ^node_modules(?:/|$) - [F,L]",
    "",
    "    # Site statique : GET, HEAD, OPTIONS seulement. Formulaire traité ici : ajouter une exception, ex.",
    "    # RewriteCond %{THE_REQUEST} !^POST\\s/+contact\\.php[\\s?] [NC]",
    "    RewriteCond %{REQUEST_METHOD} !^(GET|HEAD|OPTIONS)$ [NC]",
    "    RewriteRule ^ - [F,L]",
    "</IfModule>",
    "",
    "# Fichiers de développement jamais servis",
    "<IfModule mod_authz_core.c>",
    '    <FilesMatch "(?:\\.(?:env|ini|log|sh|md|markdown|mdc|bak|sql|sqlite|lock|ya?ml|map|swp)|~)$">',
    "        Require all denied",
    "    </FilesMatch>",
    "</IfModule>",
    "",
  );
  if (domain) {
    add(
      "<IfModule mod_setenvif.c>",
      `    SetEnvIf Host "^(www\\.)?${escapeRegex(domain)}$" FINAL_HOST`,
      "</IfModule>",
      "",
    );
  }
  add(
    "<IfModule mod_headers.c>",
    domain
      ? "    # HSTS seulement sur le domaine final (certificat public valide). Derrière Cloudflare, le réglage HSTS de Cloudflare prime."
      : "    # HSTS : à activer seulement sur le domaine final au certificat valide (renseigner le domaine final dans le hub).",
    domain
      ? '    Header always set Strict-Transport-Security "max-age=31536000" env=FINAL_HOST'
      : '    # Header always set Strict-Transport-Security "max-age=31536000"',
    '    Header always set X-Content-Type-Options "nosniff"',
    '    Header always set X-Frame-Options "SAMEORIGIN"',
    '    Header always set Referrer-Policy "strict-origin-when-cross-origin"',
    '    Header always set Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()"',
    '    Header always set Cross-Origin-Opener-Policy "same-origin"',
    '    Header always set X-Permitted-Cross-Domain-Policies "none"',
    "    # CSP : chaque service externe ajouté (formulaire, mesure d'audience, carte) ouvre seulement sa directive.",
    `    Header always set Content-Security-Policy "${DEFAULT_CSP}"`,
    "</IfModule>",
    "",
    "<IfModule mod_brotli.c>",
    "    AddOutputFilterByType BROTLI_COMPRESS text/html text/css text/plain application/javascript application/json application/xml image/svg+xml",
    "</IfModule>",
    "<IfModule mod_deflate.c>",
    "    AddOutputFilterByType DEFLATE text/html text/css text/plain application/javascript application/json application/xml image/svg+xml",
    "</IfModule>",
    "",
    "# Cache (la dernière règle qui correspond l'emporte : la plus précise en bas)",
    "<IfModule mod_headers.c>",
  );
  for (const rule of [...CACHE_RULES].reverse()) {
    add(`    # ${rule.label}`, `    <FilesMatch "${rule.pattern}">`, `        Header set Cache-Control "${rule.cacheControl}"`, "    </FilesMatch>");
  }
  add("</IfModule>", "");
  return lines.join("\n");
}

/** La configuration d'Alexandre pose-t-elle Cache-Control ? Alors le hub ne pose plus ses règles de cache. */
export const userSetsCacheControl = (userHeaders: string | undefined) => /^\s*cache-control\s*:/im.test(userHeaders ?? "");

/**
 * _headers envoyé à Pages : règles de cache du hub (chemins de build hashés), puis celles d'Alexandre.
 * Pages joint par une virgule deux valeurs d'un même en-tête : si son fichier pose Cache-Control,
 * les règles de cache du hub sont omises pour ne jamais produire de valeur double.
 */
export function buildPagesHeaders(userHeaders?: string): string | undefined {
  const hubCache = !userSetsCacheControl(userHeaders);
  const blocks: string[] = [];
  if (hubCache) {
    const hub = ["# Hub Kouzia : cache des fichiers au nom hashé (sécurité et autres règles : _worker.js)."];
    for (const rule of CACHE_RULES) for (const p of rule.pagesPaths) hub.push(p, `  Cache-Control: ${rule.cacheControl}`);
    blocks.push(hub.join("\n"));
  }
  if (userHeaders?.trim()) blocks.push(`# Règles du site\n${userHeaders.trim()}`);
  return blocks.length ? `${blocks.join("\n\n")}\n` : undefined;
}

/**
 * _redirects envoyé à Pages : le hub n'ajoute aucune règle (le _worker.js redirige pages.dev, Pages
 * redirige déjà /index.html vers /). Le fichier d'Alexandre passe tel quel.
 */
export function buildPagesRedirects(userRedirects?: string): string | undefined {
  return userRedirects?.trim() ? `${userRedirects.trim()}\n` : undefined;
}

export type PagesDeployConfig = {
  headersFile?: string;
  redirectsFile?: string;
  /** Règles de cache posées par le _worker.js (faux si le site pose lui-même Cache-Control). */
  cacheRules: boolean;
  /** Page 404 du profil copiée en /404.html (Pages ne sert que 404.html), null sinon. */
  notFoundCopyFrom: string | null;
};

/**
 * Ce qui part chez Pages en plus des fichiers : _headers et _redirects fusionnés, cache du worker, et
 * copie de la page 404 du profil en 404.html quand elle porte un autre nom (Pages sert le 404.html le
 * plus proche avec le statut 404 ; sans 404.html, il sert index.html en 200, mode application).
 */
export function pagesDeployConfig(
  profile: ServerProfile,
  paths: ReadonlySet<string>,
  user: { headers?: string; redirects?: string },
): PagesDeployConfig {
  const headersFile = buildPagesHeaders(user.headers);
  const redirectsFile = buildPagesRedirects(user.redirects);
  const custom = profile.notFoundPage.slice(1);
  return {
    ...(headersFile !== undefined ? { headersFile } : {}),
    ...(redirectsFile !== undefined ? { redirectsFile } : {}),
    cacheRules: !userSetsCacheControl(user.headers),
    notFoundCopyFrom: custom !== "404.html" && paths.has(custom) && !paths.has("404.html") ? custom : null,
  };
}
