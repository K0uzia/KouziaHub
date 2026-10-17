---
name: web-media
description: Choisit le format, la compression et le chargement de chaque image, police ou vidéo selon son rôle, et convertit les fichiers pour le web. À utiliser pour ajouter un visuel, un logo, une photo, une police, une vidéo, ou alléger une page.
---

# Médias pour le web

Source : `spec-prepare-web-media.md` et `politique-assets.md` de CapsuleOS. Principe : une politique par rôle, pas une conversion aveugle.

## Profils par rôle

| Rôle | Sortie | Réglage | Garder la source |
|------|--------|---------|------------------|
| Photo | WebP (ou AVIF) | qualité ~82 | non, après mise à jour des liens |
| Visuel de marque, hero | WebP | qualité ~90 | non |
| Icône raster | WebP sans perte | lossless | si la sortie dépasse 105 % de la source |
| Logo, pictogramme, illustration vectorielle | SVG | optimisation prudente (SVGO sans fusion de tracés) | non concerné |
| Capture servant de preuve ou de comparaison | PNG | inchangé | oui |
| Police | WOFF2 sous-ensemble | `font-display: swap` | oui (source TTF hors du site publié) |
| Vidéo | MP4 H.264 + WebM, poster WebP | `preload="none"` | oui |

- Jamais en sortie : JPEG XL, TIFF, BMP. AVIF seulement si le gain dépasse ~20 % face au WebP.
- Toujours la taille affichée : `srcset`/`sizes` ou composant d'image du framework (Astro : `astro:assets`, `<Image>`/`<Picture>`).
- Ne jamais remplacer du texte par une image de texte.

## Rangement

- Médias du site (logo, icônes, visuels de marque) et contenus éditoriaux (photos d'articles, produits) dans deux dossiers distincts, chacun à un seul endroit.
- Jamais d'asset inventé, généré pour combler un manque ou emprunté à un autre projet : l'emplacement reste vide et la pièce manquante est signalée.
- Captures d'écran de travail, maquettes et preuves de recette hors du dossier publié.
- Crédits et licences des images, polices et icônes notés à côté du fichier ou dans les mentions légales.

## Commandes

```bash
cwebp -q 82 photo.jpg -o photo.webp
cwebp -lossless icone.png -o icone.webp
avifenc --min 20 --max 30 photo.jpg photo.avif
npx --yes svgo --multipass logo.svg
pyftsubset Police.ttf --flavor=woff2 --layout-features='*' --unicodes='U+0000-00FF,U+0131,U+0152-0153,U+2018-201E,U+2026,U+20AC' --output-file=police.woff2
ffmpeg -i video.mov -c:v libx264 -crf 26 -preset slow -an -movflags +faststart video.mp4
```

Après conversion : mettre à jour les références (HTML, CSS, données), puis relancer le build et `check-dist.mjs` pour détecter un lien cassé ou une image sans dimensions.

## Chargement

- Image LCP : `loading="eager"`, `fetchpriority="high"`, pas de squelette par-dessus, au plus une précharge.
- Autres : `loading="lazy"`, `decoding="async"`, `width`/`height` ou `aspect-ratio`.
- Emplacement prévu sans média réel : cadre aux dimensions finales, vide et sans animation, jamais un visuel factice.
