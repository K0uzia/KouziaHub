---
name: web-a11y-audit
description: Audite l'accessibilité d'un site (WCAG 2.2 AA) par scan axe-core automatisé puis passe manuelle clavier, zoom et contraste, et prépare la déclaration d'accessibilité. À utiliser pour une page, un formulaire, un menu, un dialogue ou avant une mise en production.
---

# Audit d'accessibilité

Source : gate `validate-a11y.mjs` et contrat `a11y-scan-targets.json` de CapsuleOS.

## 1. Scan automatisé

Site servi en local (`npm run preview` ou `astro dev --background`), puis :

```bash
npx --yes @axe-core/cli http://localhost:4321/ --tags wcag2a,wcag2aa,wcag22aa --exit
```

- `critical` et `serious` : bloquants, à corriger avant livraison.
- `moderate` et `minor` : à corriger au fil de l'eau, listés dans le rapport.
- Scanner chaque gabarit distinct (accueil, page de contenu, formulaire, 404), pas seulement l'accueil.
- Scanner aussi chaque état activable : thème clair/sombre, menu mobile ouvert, réglages d'accessibilité s'il y en a.

Un scan ne couvre qu'environ un tiers des critères. La passe manuelle est obligatoire.

## 2. Passe manuelle

1. Tabulation sur toute la page : lien d'évitement en premier, ordre visuel respecté, focus toujours visible, aucun piège.
2. Menu et dialogue au clavier : ouverture, Échap, retour du focus au déclencheur, `aria-expanded` à jour.
3. Formulaire vide soumis : message en texte, relié par `aria-describedby`, focus déplacé sur le premier champ en erreur.
4. Contraste de chaque thème : texte, boutons, filets de champs, focus.
5. Largeur 320 px et zoom texte 200 % : rien de coupé, pas de scroll horizontal.
6. `prefers-reduced-motion` activé : plus aucune animation.
7. Lecteur d'écran (NVDA ou Orca) sur le parcours principal : titres, repères, noms des liens hors contexte.
8. Élément masqué visuellement (`opacity`, hors écran) mais toujours focusable : interdit.

## 3. Déclaration d'accessibilité

Page dédiée liée depuis le pied de page : état de conformité (total, partiel, non conforme), périmètre couvert, limites connues, date et méthode du dernier audit, contact pour signaler un problème, voie de recours (Défenseur des droits). Garder la date à jour après chaque audit.
