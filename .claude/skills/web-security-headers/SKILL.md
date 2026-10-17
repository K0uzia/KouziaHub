---
name: web-security-headers
description: Écrit ou audite le .htaccess (Apache, LiteSpeed, Hostinger) d'un site : HTTPS, HSTS, CSP, en-têtes OWASP, blocage des fichiers sensibles, cache, CORS, puis vérifie en production avec curl. À utiliser pour un déploiement, un .htaccess, des en-têtes HTTP ou une erreur 403 inattendue.
---

# En-têtes et durcissement serveur

Source : `.htaccess` et `SECURITY.md` de CapsuleOS (mapping OWASP Top 10 2021), généralisés.

## Gabarit `.htaccess`

Remplacer `example\.com` par le domaine. Retirer ce qui ne sert pas (CORS, POST) plutôt que de l'élargir.

```apache
# A05 configuration
Options -Indexes -MultiViews +FollowSymLinks
ServerSignature Off
ErrorDocument 404 /404.html

<IfModule mod_rewrite.c>
    RewriteEngine On

    # A02 HTTPS, uniquement sur l'hôte public (un certificat auto-signé de recette casserait les cookies)
    RewriteCond %{HTTPS} !=on
    RewriteCond %{HTTP_HOST} ^(www\.)?example\.com$ [NC]
    RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L,NE]

    # Une seule URL canonique : www vers apex, /index.html vers /
    RewriteCond %{HTTP_HOST} ^www\.(example\.com)$ [NC]
    RewriteRule ^ https://%1%{REQUEST_URI} [R=301,L,NE]
    RewriteRule ^(.*/)?index\.html$ /$1 [R=301,L]

    # A01 fichiers cachés (.git, .env), sauf /.well-known/
    RewriteRule (^|/)\.(?!well-known/) - [F,L]
    RewriteRule ^(?:node_modules|src|vendor)(?:/|$) - [F,L]

    # A01 méthodes : statique en GET/HEAD/OPTIONS. Ajouter une exception par point d'entrée POST réel.
    # LiteSpeed (Hostinger) : tester THE_REQUEST, pas REQUEST_URI, qui peut y être absolu.
    RewriteCond %{REQUEST_METHOD} !^(GET|HEAD|OPTIONS)$ [NC]
    # RewriteCond %{THE_REQUEST} !^[A-Z]{3,}\s/+contact\.php[\s?] [NC]
    RewriteRule ^ - [F,L]
</IfModule>

# A05 types sensibles jamais servis
<FilesMatch "\.(?:env|ini|log|sh|md|mdc|bak|sql|sqlite|lock|ya?ml|map)$">
    Require all denied
</FilesMatch>

<IfModule mod_setenvif.c>
    SetEnvIf Host "^(www\.)?example\.com$" PUBLIC_HOST
    # Variantes à paramètres (tri, filtre, suivi) : pas d'indexation
    SetEnvIf Query_String "(^|&)(utm_[a-z]+|sort|filter|q)=" NOINDEX_QUERY
</IfModule>

<IfModule mod_headers.c>
    Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains" env=PUBLIC_HOST
    Header always set X-Content-Type-Options "nosniff"
    Header always set X-Frame-Options "SAMEORIGIN"
    Header always set Referrer-Policy "strict-origin-when-cross-origin"
    Header always set X-Permitted-Cross-Domain-Policies "none"
    Header always set Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()"
    Header always set Cross-Origin-Opener-Policy "same-origin"
    Header always set Cross-Origin-Resource-Policy "same-site"
    Header always set X-Robots-Tag "noindex, follow" env=NOINDEX_QUERY
    Header always set Content-Security-Policy "default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; upgrade-insecure-requests"
</IfModule>

<IfModule mod_deflate.c>
    AddOutputFilterByType DEFLATE text/html text/css application/javascript application/json image/svg+xml text/plain application/xml
</IfModule>

<IfModule mod_expires.c>
    ExpiresActive On
    ExpiresDefault "access plus 1 hour"
    ExpiresByType text/html "access plus 0 seconds"
    ExpiresByType text/css "access plus 7 days"
    ExpiresByType application/javascript "access plus 7 days"
    ExpiresByType image/webp "access plus 30 days"
    ExpiresByType image/avif "access plus 30 days"
    ExpiresByType image/svg+xml "access plus 30 days"
    ExpiresByType font/woff2 "access plus 1 year"
</IfModule>

# Fichiers au nom hashé (Astro : /_astro/, Vite : /assets/)
<IfModule mod_headers.c>
    <FilesMatch "\.[0-9a-zA-Z_-]{8,}\.(?:css|js|woff2|webp|avif|svg)$">
        Header set Cache-Control "public, max-age=31536000, immutable"
    </FilesMatch>
</IfModule>
```

## Adapter la CSP

- Chaque service externe ajouté (formulaire, mesure d'audience) ouvre seulement sa directive : `form-action 'self' https://api.web3forms.com`, `connect-src 'self' https://stats.example.com`.
- `script-src 'unsafe-inline'` : à éviter. Préférer des scripts externes `'self'` ou des empreintes `'sha256-…'`. S'il reste, le noter comme dette dans `SECURITY.md`.
- `frame-ancestors 'none'` + `X-Frame-Options: DENY` sur les pages sensibles (connexion, compte, admin).
- Après déploiement : console du navigateur, aucune ressource bloquée par la CSP.

## CORS (seulement si un autre site charge vos ressources en fetch)

```apache
SetEnvIf Origin "^https://(www\.)?partenaire\.org$" CORS_ORIGIN=$0
Header always set Access-Control-Allow-Origin "%{CORS_ORIGIN}e" env=CORS_ORIGIN
Header always set Vary "Origin" env=CORS_ORIGIN
```

Jamais `*`, jamais une liste avec `/*` (invalide).

## Vérification post-déploiement

```bash
bash .claude/skills/web-audit/scripts/check-headers.sh https://example.com
```

Puis contrôle externe : securityheaders.com et observatory.mozilla.org (note visée A).

## Pièges connus

- LiteSpeed : `REQUEST_URI` peut être absolu, toutes les conditions basées dessus échouent (403 sur tout POST). Utiliser `THE_REQUEST`.
- LiteSpeed : certains noms commençant par un point restent en 403 même avec une exception ; ne pas servir de fichiers runtime nommés `.quelquechose`.
- HSTS posé sur un hôte de recette auto-signé bloque ce domaine dans le navigateur ; pour l'annuler : `max-age=0` sur cet hôte.
- Canonical vers une URL qui redirige : Google l'ignore. Toujours pointer la cible finale.
