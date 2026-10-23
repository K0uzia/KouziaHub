# Design system, mise en page et finition

## Tokens (N0, N1, N2)

- N0 : couleurs, typo, espaces, rayons, durées, courbes. Seul endroit des valeurs brutes (`#hex`, `px`).
- N1 : composants (bouton, carte, champ, lien) en `var(--*)` uniquement.
- N2 : pages, assemblent des N1. Avant toute classe nouvelle : étendre un token ou un composant existant.
- Toute `var(--x)` utilisée est définie. Une seule source par token, pas de doublon d'échelle.
- Un rôle visuel = un composant. États prévus : repos, survol, focus clavier, actif, désactivé, chargement, vide, erreur.
- Ordre des propriétés CSS : `position`, `display`, `width`, `height`, `margin`, `padding`, `border`, `font`, `color`, `background`, `transform`, `animation`, `transition`, `overflow`, `z-index`.

## Mise en page fluide

- Polices en tokens définis une fois (`--font-ui`, `--font-mono`), jamais de `font-family` en dur dans un composant.
- Typo et espacements en `clamp()` ou `rem` via tokens. `px` réservé aux filets de 1 px.
- 320 px à grand écran sans scroll horizontal. Grilles en `minmax`/`auto-fit`, pas en largeurs d'appareils. Mesure de lecture ~65 caractères.
- Interface centrée et adaptée jusqu'aux écrans de 27 pouces (2560 × 1440) : conteneur principal centré (`margin-inline: auto`), largeur maximale fluide qui grandit avec l'écran au lieu de figer une colonne étroite, typo, densité et cibles en `clamp()` qui suivent la largeur. Le texte courant garde sa mesure de lecture ; les listes, tableaux et tableaux de bord occupent la largeur utile. Contrôle visuel obligatoire à 360, 800, 1280, 1920 et 2560 px.
- Header fixe : `scroll-padding-top` égal à sa hauteur réelle.
- Centrage optique dans une barre asymétrique : `position: absolute; left: 50%; translate: -50%`, hors du flux.

## Mouvement

- Le mouvement confirme une action, il ne décore pas. Animer `opacity` et `transform` uniquement.
- Retour ~150 ms, entrée ~300 ms, une courbe en token. Contenu lisible sans attendre l'animation.
- `prefers-reduced-motion: reduce` : animations et défilement doux coupés.
- Interdit : parallaxe, défilement détourné, boucle décorative, `filter: blur` sur grande surface.
- Interdit : la bordure gauche épaisse et colorée comme accent d'une carte, d'un encadré, d'un bandeau ou d'une tuile (cliché des interfaces générées), à l'écran comme dans les PDF et les e-mails. La hiérarchie passe par la taille, la graisse, l'espace, un fond ou un contour complet de 1 px. Seule exception : le filet d'une citation de message (blockquote).
- Interdit : le tiret cadratin déguisé (autre cliché des interfaces générées) : trait court en `::before`/`::after` devant un sur-titre, un intitulé ou une puce, `content` en tiret (y compris par échappement), image ou SVG de tiret. À la place : rien, une petite forme pleine ou une icône. Les filets fonctionnels (séparateur, fil d'étapes, poignée, frise) restent permis.

## Icônes et contenu

- Icônes en SVG local généré au build (ex. Font Awesome Free). Interdit : CDN, kit, police d'icônes, emoji ou caractère Unicode comme icône d'interface.
- Icône décorative `aria-hidden="true"` ; icône seule dans un contrôle : nom accessible sur le contrôle.
- Aucun texte de démo en production : une donnée manquante masque la section.
