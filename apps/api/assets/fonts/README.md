# Polices du rapport mensuel (PDF)

Embarquées en local par `@react-pdf/renderer` (jamais chargées depuis un CDN). Fichiers TTF statiques : le woff2 variable de l'interface fait planter le moteur de PDF. Deux graisses par famille.

| Fichier | Famille, graisse | Source | Version |
|---|---|---|---|
| `Exo2-SemiBold.ttf`, `Exo2-Bold.ttf` | Exo 2, 600 et 700 (titres) | https://github.com/googlefonts/Exo-2.0 (`fonts/ttf/`), commit `f83ea8a02d3e1d6963ab6e910038521f27e283a2` (celui de Google Fonts) | 1.100 |
| `SourceSans3-Regular.ttf`, `SourceSans3-Semibold.ttf` | Source Sans 3, 400 et 600 (texte, chiffres tabulaires par défaut) | https://github.com/adobe-fonts/source-sans, version publiée `3.052R` (archive `TTF-source-sans-3.052R.zip`) | 3.052 |

Licences : SIL Open Font License 1.1, `OFL-Exo2.txt` (copie de `ofl/exo2/OFL.txt` de google/fonts) et `OFL-SourceSans3.md` (`LICENSE.md` d'adobe-fonts/source-sans, version 3.052R). Téléchargées le 18/10/2026.

Exo 2 n'a ni espace fine insécable ni « ᵉʳ » : elle sert aux titres et libellés seulement ; dates, nombres et texte courant sont en Source Sans 3.
