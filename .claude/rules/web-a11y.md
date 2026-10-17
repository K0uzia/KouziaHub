# Accessibilité (WCAG 2.2 AA, base RGAA 4.1)

Niveau AA par défaut sur tout site. Ce n'est pas une passe de fin de projet.

- Contraste : texte ≥ 4,5:1, grand texte et composants d'interface ≥ 3:1, dans chaque thème livré. Une information n'est jamais portée par la couleur seule.
- `:focus-visible` toujours visible. `outline: none` interdit sans style de remplacement.
- Cibles tactiles ≥ 24×24 px (critère 2.5.8), viser 44×44 px sur mobile.
- `lang` sur `<html>`. Un seul `h1`, titres sans saut de niveau. Repères `header`, `nav`, `main`, `footer`. Lien d'évitement vers `main`.
- Chaque contrôle a un nom accessible. Image informative : `alt` utile. Décor : `alt=""` ou `aria-hidden="true"`.
- Clavier complet, ordre logique, aucun piège. Échap ferme un panneau et rend le focus au déclencheur.
- Formulaires : `label` visible, `autocomplete` renseigné, erreur en texte reliée par `aria-describedby` avec `aria-invalid`.
- Reflow : 320 px de large et zoom texte 200 % sans perte de contenu ni scroll horizontal.
- Préférences respectées : `prefers-reduced-motion`, `prefers-color-scheme` si plusieurs thèmes.
- Gate : scan axe-core (`wcag2a`, `wcag2aa`, `wcag22aa`), impacts `serious` et `critical` bloquants. Procédure : skill `web-a11y-audit`.
