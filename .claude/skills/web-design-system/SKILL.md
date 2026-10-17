---
name: web-design-system
description: Pose ou étend les tokens (couleurs, typo, espaces, rayons, durées), range un style au bon niveau (token, composant, page), choisit une icône, pose une animation et contrôle la fluidité de 320 px au grand écran. À utiliser pour une couleur, une police, un bouton, une carte, une section, une icône, une transition ou un problème de mise en page.
---

# Design system

Contraintes : rule `web-design`. Source : convention tokens N0/N1/N2, skills `role-web-designer` et `design-shell-layout` de CapsuleOS, et kit Cursor de Kouzia.

## 1. Fichier de tokens (N0)

```css
:root {
  /* couleurs : rôle, pas teinte */
  --color-bg: #0f1115;
  --color-surface: #171a21;
  --color-text: #e8eaed;
  --color-text-muted: #a9b0bb;   /* vérifier ≥ 4,5:1 sur --color-bg */
  --color-accent: #4f8cff;
  --color-focus: var(--color-accent);
  --color-danger: #ff6b6b;

  /* typo */
  --font-ui: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, "Cascadia Code", "DejaVu Sans Mono", monospace;
  --step--1: clamp(0.83rem, 0.8rem + 0.15vw, 0.9rem);
  --step-0: clamp(1rem, 0.95rem + 0.25vw, 1.125rem);
  --step-1: clamp(1.2rem, 1.1rem + 0.5vw, 1.45rem);
  --step-2: clamp(1.44rem, 1.25rem + 0.9vw, 1.9rem);
  --step-3: clamp(1.73rem, 1.4rem + 1.6vw, 2.6rem);

  /* espace : une échelle */
  --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 1rem;
  --space-4: 1.5rem;  --space-5: 2.5rem; --space-6: clamp(3rem, 2rem + 4vw, 6rem);

  --radius: 0.75rem;
  --duration-fast: 150ms;
  --duration-base: 300ms;
  --ease: cubic-bezier(0.2, 0, 0, 1);
  --measure: 65ch;
}
```

Valeurs indicatives : partir de la charte réelle du client. Un seul accent, un seul rayon. Mode clair et sombre : redéfinir seulement les tokens de couleur dans `@media (prefers-color-scheme: dark)` ou `[data-theme]`.

## 2. Ranger un style

| Niveau | Contient | Règle |
|--------|----------|-------|
| N0 tokens | valeurs brutes | seul endroit des `#hex` et `px` |
| N1 composants | bouton, carte, champ, lien, badge | `var(--*)` uniquement, tous les états |
| N2 pages | sections | assemblent des N1, aucun style de composant redéfini |

Avant d'écrire une classe : un token ou un composant existant peut-il s'étendre (variante, propriété personnalisée) ? Si oui, l'étendre. Contrôle des variables orphelines : `check-dist.mjs` (skill `web-audit`).

## 3. Icônes

1. Nommer le sens (« téléphone », « lieu »), pas la forme.
2. Chercher dans la bibliothèque locale du projet (ex. Font Awesome Free : solid, puis regular, puis brands ; ou Lucide, Heroicons).
3. Rendu SVG au build (`viewBox`, `fill="currentColor"`), via un composant unique du projet.
4. Aucune icône ne porte ce sens : petit SVG maison en `currentColor`, aussi simple que la bibliothèque.

## 4. Animation

Le contenu est dans le HTML avant l'animation ; une classe ne fait que jouer `opacity` et `transform`.

```css
.reveal { opacity: 0; transform: translateY(0.75rem); transition: opacity var(--duration-base) var(--ease), transform var(--duration-base) var(--ease); }
.reveal.is-visible { opacity: 1; transform: none; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
  .reveal { opacity: 1; transform: none; }
}
```

Sans JS, `.reveal` doit rester visible : ajouter la classe d'attente par script (`document.documentElement.classList.add('js')` puis `.js .reveal`).

## 5. Contrôle de fluidité

1. Largeurs 320, 375, 768, 1024, 1280, 1920 px, puis zoom texte 200 %.
2. Aucun scroll horizontal, aucun texte coupé, cibles entières.
3. Colonnes en `repeat(auto-fit, minmax(min(100%, 18rem), 1fr))` plutôt qu'en breakpoints d'appareils.
4. Header fixe : mesurer sa hauteur réelle, la reporter dans `scroll-padding-top`.
5. Alignements : mesurer (DevTools, `getBoundingClientRect`), ne pas deviner ; écart de centrage visé < 3 px.
