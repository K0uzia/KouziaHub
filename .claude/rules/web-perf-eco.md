# Performance et éco-conception

Chaque octet et chaque requête doivent servir le contenu. Statique par défaut. Référentiels : Core Web Vitals, RGESN.

## Seuils (mobile, 75e percentile)

- LCP ≤ 2,5 s · INP ≤ 200 ms · CLS ≤ 0,1.
- Page vitrine : viser < 500 Ko transférés en première vue et < 30 requêtes. Mesurer, ne pas estimer.

## Règles

- Zéro JavaScript si la page fonctionne sans. Pas de framework client pour du contenu statique.
- Aucun script tiers par défaut (pixel, widget, chat, police CDN, carte embarquée). Chaque exception est justifiée par écrit.
- Polices : pile système par défaut. Police de marque en `.woff2` local, sous-ensemble, `font-display: swap`, 2 graisses maximum.
- Images : dimension affichée, WebP ou AVIF, `width`/`height` ou `aspect-ratio`. Élément LCP : `fetchpriority="high"`, jamais `loading="lazy"`. Le reste : `loading="lazy"` et `decoding="async"`.
- Vidéo : jamais en lecture automatique avec son, `preload="none"`, poster léger.
- Cache : fichiers au nom hashé 1 an `immutable` ; CSS/JS non hashés 7 jours ; images 30 jours ; HTML court. Compression Brotli ou gzip côté serveur.
- Sobriété fonctionnelle : une fonctionnalité sans usage mesuré ou demandé n'est pas livrée.
- Procédures : skills `web-media` (formats, polices) et `web-audit` (mesure).
