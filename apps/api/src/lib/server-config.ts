// Configuration serveur d'un site, générée depuis une seule source : son profil.
// - .htaccess (Apache, LiteSpeed chez Hostinger) : écrit dans la version de travail, modifiable.
// - Cloudflare Pages (.htaccess ignoré) : _headers et règles de cache du _worker.js, au déploiement.
// Fonctions pures : aucun accès à la base ni aux fichiers.

import { DEV_TOOLING } from "./site-paths.js";

export type CanonicalHost = "www" | "apex";

export type ServerProfile = {
  /** Domaine final sans « www. » (ex. « client.fr »), null tant qu'il n'est pas connu. */
  finalDomain: string | null;
  canonicalHost: CanonicalHost;
  /** Chemin depuis la racine (ex. « /404.html »). */
  notFoundPage: string;
  /** CSP du site (onglet Serveur) ; absente : CSP par défaut de l'export. */
  csp?: string | null;
  /** Exceptions du site aux fichiers d'outillage refusés. */
  allow?: readonly string[];
};

/**
 * Ce que le .htaccess lit dans les fichiers du site (version de travail ou version exportée) : il suit le
 * contenu réel, jamais une supposition.
 */
export type SiteContent = {
  /** Dossiers de fichiers au nom hashé réellement présents (« _astro », « assets », « _next/static »...). */
  hashedDirs: string[];
  /** La page 404 du profil existe. */
  notFoundPresent: boolean;
  /** Sitemaps présents à la racine (« sitemap-index.xml », « sitemap.xml »...). */
  sitemaps: string[];
};

/** Dossiers de build aux noms hashés, connus des générateurs : Vite, Astro, Next.js, SvelteKit, Nuxt. */
export const HASHED_DIRS = ["assets", "_astro", "_next/static", "_app/immutable", "_nuxt"] as const;

export function siteContentOf(paths: Iterable<string>, notFoundPage: string): SiteContent {
  const list = [...paths];
  return {
    hashedDirs: HASHED_DIRS.filter((d) => list.some((p) => p.startsWith(`${d}/`))),
    notFoundPresent: list.includes(notFoundPage.slice(1)),
    sitemaps: list.filter((p) => /^sitemap[^/]*\.xml$/i.test(p)).sort(),
  };
}

export const HTACCESS_PATH = ".htaccess";
export const DEFAULT_NOT_FOUND = "/404.html";
export const GENERATED_MARKER = "# Généré par le hub Kouzia.";

/**
 * Règles de cache (règle web-perf-eco), source unique du .htaccess, du _headers et du _worker.js.
 * Ordre : la première règle qui correspond s'applique. `pattern` s'applique au chemin de l'URL.
 * Immuable seulement par dossier (/assets/, /_astro/ : noms hashés par Vite et Astro) : un motif sur
 * le nom (« .xxxxxxxx.js ») prendrait « jquery.carousel.js » pour un fichier hashé et figerait un an
 * un fichier qui change.
 */
export const CACHE_RULES: ReadonlyArray<{ label: string; pattern: string; cacheControl: string; pagesPaths: string[]; byPath?: true }> = [
  {
    label: "Fichiers au nom hashé (Vite /assets/, Astro /_astro/) : 1 an, immuables",
    pattern: "^/(?:assets|_astro)/",
    byPath: true,
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

/**
 * En-têtes de sécurité du site en production (règle web-security), source unique du .htaccess et du
 * _headers de l'export Cloudflare Pages. Pas de X-Robots-Tag : propre à la version de travail.
 */
export const PRODUCTION_SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "SAMEORIGIN"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()"],
  ["Cross-Origin-Opener-Policy", "same-origin"],
  ["X-Permitted-Cross-Domain-Policies", "none"],
  ["Content-Security-Policy", DEFAULT_CSP],
];

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

/** Directives que la CSP du site ne peut pas changer : elles restent celles de la CSP de base. */
const IMPOSED_DIRECTIVES = ["frame-ancestors", "object-src"];

/**
 * CSP du site ajoutée à une CSP de base sans l'affaiblir : chaque directive du site remplace celle de même nom,
 * sauf frame-ancestors et object-src, toujours imposées par la base (anti-intégration et plugins).
 */
export function mergeCsp(base: string, site: string | null | undefined): string {
  const parse = (csp: string) =>
    csp
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => [d.split(/\s+/)[0]!.toLowerCase(), d] as const);
  const merged = new Map(parse(base));
  for (const [name, directive] of parse(site ?? "")) {
    if (!IMPOSED_DIRECTIVES.includes(name)) merged.set(name, directive);
  }
  return [...merged.values()].join("; ");
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Outillage du projet refusé en 403 (même liste que l'envoi et le _worker.js : DEV_TOOLING). Une exception du
 * site (chemin exact) : son nom sort de la liste par nom (FilesMatch ne voit que le nom), et une condition
 * l'excepte de la règle du dossier src/.
 */
function toolingDenyRules(allow: readonly string[]): string[] {
  const allowedNames = new Set(allow.map((a) => a.split("/").pop()!.toLowerCase()));
  const names = DEV_TOOLING.names.filter((n) => !allowedNames.has(n)).map(escapeRegex);
  const patterns = DEV_TOOLING.patterns.map((p) => p.replace(/^\^|\$$/g, ""));
  const rootDirs = DEV_TOOLING.rootDirs;
  const out = [
    "# Outillage du projet (package.json, verrous, configuration de build, src/) : jamais servi.",
    "<IfModule mod_authz_core.c>",
    `    <FilesMatch "(?i)^(?:${[...names, ...patterns].join("|")})$">`,
    "        Require all denied",
    "    </FilesMatch>",
    "</IfModule>",
    "<IfModule mod_rewrite.c>",
    "    RewriteEngine On",
    ...DEV_TOOLING.rootPatterns.map((p) => `    RewriteRule ${p} - [F,L,NC]`),
    ...rootDirs.flatMap((d) => [
      ...allow.filter((a) => a.toLowerCase().startsWith(`${d}/`)).map((a) => `    RewriteCond %{REQUEST_URI} !^/${escapeRegex(a)}$`),
      `    RewriteRule ^${escapeRegex(d)}(?:/|$) - [F,L,NC]`,
    ]),
    "</IfModule>",
  ];
  if (allow.length) out.push(`# Exceptions du site (onglet Serveur), servies : ${allow.join(", ")}`);
  out.push("");
  return out;
}

/**
 * .htaccess complet. Tout est sous IfModule : un module absent n'empêche jamais le site de répondre.
 * Protections toujours présentes (en-têtes, 403 sur les fichiers cachés et de développement, -Indexes,
 * ServerSignature Off, méthodes, cache par type, compression, HTTPS 301) ; ce qui dépend d'une donnée absente
 * (domaine final, page 404) est commenté « À compléter », jamais écrit faux.
 */
export function buildHtaccess(profile: ServerProfile, content: SiteContent): string {
  const lines: string[] = [];
  const add = (...l: string[]) => lines.push(...l);
  add(
    `${GENERATED_MARKER} Modifiable : le hub ne l'écrase plus s'il est modifié à la main`,
    "# (régénération seulement sur confirmation, depuis la fiche du site).",
    "# Source : profil du site (domaine final, forme canonique, page 404) et fichiers de la version, dans le hub.",
    "# Régénéré à chaque publication tant qu'il n'est pas modifié à la main.",
    "# Sert à l'hébergement final (Hostinger) : Cloudflare Pages, qui sert la version de travail, l'ignore.",
    "",
    "# Listing des dossiers coupé (AllowOverride Options requis, autorisé chez Hostinger).",
    "Options -Indexes -MultiViews",
    "ServerSignature Off",
    "DirectoryIndex index.html",
    ...(content.notFoundPresent
      ? [`ErrorDocument 404 ${profile.notFoundPage}`]
      : [
          `# À compléter : page 404 absente des fichiers (${profile.notFoundPage}) : ajoutez-la, ou changez la page 404 dans l'onglet Serveur.`,
          `# ErrorDocument 404 ${profile.notFoundPage}`,
        ]),
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
      "    # À compléter : domaine final non renseigné dans l'onglet Serveur (redirection www ou sans www, HSTS).",
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
    ...toolingDenyRules(profile.allow ?? []),
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
      : "    # À compléter : domaine final non renseigné dans l'onglet Serveur (HSTS seulement sur le domaine final au certificat valide).",
    domain
      ? '    Header always set Strict-Transport-Security "max-age=31536000" env=FINAL_HOST'
      : '    # Header always set Strict-Transport-Security "max-age=31536000"',
    ...PRODUCTION_SECURITY_HEADERS.filter(([name]) => name !== "Content-Security-Policy").map(([name, value]) => `    Header always set ${name} "${value}"`),
    profile.csp
      ? "    # CSP du hub complétée par la CSP du site (onglet Serveur) ; frame-ancestors et object-src restent imposées."
      : "    # CSP : chaque service externe ajouté (formulaire, mesure d'audience, carte) ouvre seulement sa directive.",
    `    Header always set Content-Security-Policy "${mergeCsp(DEFAULT_CSP, profile.csp)}"`,
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
  // Les règles par dossier passent par une variable d'environnement (FilesMatch ne voit que le nom du
  // fichier) ; les règles par type l'excluent, car les FilesMatch s'appliquent après et l'écraseraient.
  // Dossiers hashés : seulement ceux présents dans les fichiers (un an d'immuabilité sur un dossier absent ne sert à rien).
  const immutable = CACHE_RULES.find((r) => r.byPath)!;
  const dirs = content.hashedDirs;
  const guard = dirs.length > 0 ? " env=!HUB_PATH_CACHE" : "";
  for (const rule of [...CACHE_RULES].reverse()) {
    if (rule.byPath) continue;
    add(`    # ${rule.label}`, `    <FilesMatch "${rule.pattern}">`, `        Header set Cache-Control "${rule.cacheControl}"${guard}`, "    </FilesMatch>");
  }
  if (dirs.length > 0) {
    add(
      `    # Fichiers au nom hashé (${dirs.map((d) => `/${d}/`).join(", ")}, présents dans les fichiers) : 1 an, immuables`,
      "    <IfModule mod_setenvif.c>",
      `        SetEnvIf Request_URI "^/(?:${dirs.map(escapeRegex).join("|")})/" HUB_PATH_CACHE`,
      "    </IfModule>",
      `    Header set Cache-Control "${immutable.cacheControl}" env=HUB_PATH_CACHE`,
    );
  } else {
    add("    # Aucun dossier de fichiers hashés dans les fichiers (assets/, _astro/, _next/static/...) : pas de cache d'un an.");
  }
  if (content.sitemaps.length > 0) {
    add(
      `    # Sitemap présent (${content.sitemaps.map((p) => `/${p}`).join(", ")}) et robots.txt : revalidés chaque heure`,
      '    <FilesMatch "^(?:sitemap[^/]*\\.xml|robots\\.txt)$">',
      '        Header set Cache-Control "public, max-age=3600"',
      "    </FilesMatch>",
    );
  } else {
    add("    # Pas de sitemap dans les fichiers (sitemap.xml ou sitemap-index.xml à la racine).");
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
 * _headers de l'export de production pour Cloudflare Pages : en-têtes de sécurité sur /* (mêmes que le
 * .htaccess ; HSTS seulement si le domaine final est connu), puis cache du hub et règles du site.
 */
export function buildProductionPagesHeaders(userHeaders: string | undefined, finalDomain: string | null): string {
  const security = ["# Hub Kouzia : en-têtes de sécurité du site en production.", "/*"];
  for (const [name, value] of PRODUCTION_SECURITY_HEADERS) security.push(`  ${name}: ${value}`);
  if (finalDomain) security.push("  Strict-Transport-Security: max-age=31536000");
  const rest = buildPagesHeaders(userHeaders) ?? "";
  return [security.join("\n"), rest.trimEnd()].filter(Boolean).join("\n\n") + "\n";
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
