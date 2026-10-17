---
name: web-seo-structured-data
description: Renseigne et contrôle title, meta, Open Graph, canonical, robots.txt, sitemap.xml, llms.txt et le graphe JSON-LD schema.org à partir du contenu visible. À utiliser pour le référencement Google, les résultats enrichis, une FAQ, le partage social ou la visibilité dans les assistants IA (GEO).
---

# Référencement et données structurées

Source : `convention-schema-org.md`, `robots.txt`, `llms.txt` et gate `validate-schema-org.mjs` de CapsuleOS.

## 1. Une source, deux projections

Les données (identité, services, FAQ) vivent dans un seul fichier de données. Le HTML visible et le JSON-LD sont générés depuis lui. Ne jamais recopier une FAQ à la main dans les deux.

## 2. Règles du graphe JSON-LD

1. Un `@graph` par page, un `@id` stable par nœud (`https://example.com/#organization`, `#website`, `#webpage`). Deux types sur le même `@id` fusionnent en un nœud inexploitable.
2. Les nœuds se référencent par `{"@id": "…"}`, ils ne se recopient pas.
3. `logo` est un `ImageObject` vers un fichier qui existe, pas une page.
4. Booléens en booléens (`true`), nombres en nombres, dates ISO 8601.
5. Un nœud par intention de recherche : l'entreprise (`Organization`/`LocalBusiness`/`ProfessionalService`), le site (`WebSite`), le produit ou service, le contenu. Ne pas tout fusionner.
6. Domaines distincts (site et maison mère) : ne pas les mélanger dans `url` et `@id`, sinon l'attribution se disperse.
7. Types utiles selon le site : `BreadcrumbList` (sous-pages), `FAQPage`, `Article`, `Product`/`Offer`, `Event`, `LocalBusiness` (adresse, horaires, `geo`). Pas de `Review` ni `AggregateRating` sans avis réels affichés.

## 3. FAQ

- Chaque question et chaque réponse balisées figurent mot pour mot dans le HTML servi (pas injectées en JS).
- Rendu conseillé : `<details>`/`<summary>`, sans script.
- Une réponse ne promet que ce que le site ou l'entreprise fait réellement.

## 4. Fichiers d'indexation

| Fichier | Contenu |
|---------|---------|
| `robots.txt` | `Allow: /` public ; `Allow` explicite des CSS/JS utiles au rendu ; `Disallow` admin, API, brouillons ; `Sitemap:` absolu |
| `sitemap.xml` | URL canoniques indexables uniquement, `loc` absolu, `lastmod` réel |
| `llms.txt` | titre `#`, résumé `>` d'une phrase, sections `##` de liens `[Page](url): description` ; mêmes faits que le site |

## 5. Contrôle

```bash
npm run build
node .claude/skills/web-audit/scripts/check-dist.mjs dist https://example.com
```

Le script vérifie : `lang`, `h1` unique, longueur et unicité de `title` et description, canonical absolu, `og:image` absolue, JSON-LD parsable, `@id` dupliqués entre nœuds, questions et réponses `FAQPage` présentes dans le texte visible.

Ensuite, en ligne : Test des résultats enrichis Google, validateur schema.org, Search Console (couverture, sitemap soumis).
