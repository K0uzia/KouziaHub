---
name: web-ui-states
description: Spécifie et vérifie les états et transitions d'un composant interactif (menu, onglets, accordéon, modale, formulaire, panier, filtre, carrousel) - matrice état/action/état, cohérence entre l'état et l'affichage, absence de rafraîchissement parasite, preuves avant/après. À utiliser pour créer, déboguer ou tester une interaction.
---

# États d'interface

Source : `convention-rafraichissement-vues.md`, `procedure-audit-etats-ui-effets.md` et `contrats-ui-bureau.md` de CapsuleOS, généralisés.

## 1. Le principe

- **M** : l'état (données, URL, onglet actif, panier, sélection, erreurs).
- **V** : ce qui est affiché (DOM, attributs ARIA, URL visible, titre).
- Correct : après chaque action terminée, `V = projection(M)`. Incorrect : V périmée après une action, ou V qui change alors que M n'a pas changé.

## 2. Matrice avant de coder

Pour chaque composant, écrire la table des transitions :

| État de départ | Action (souris, clavier, tactile, système) | État d'arrivée | Ce qui doit changer à l'écran | ARIA et focus |
|----------------|---------------------------------------------|----------------|-------------------------------|---------------|
| menu fermé | clic ou Entrée sur le bouton | ouvert | panneau visible | `aria-expanded="true"`, focus sur le 1er lien |
| menu ouvert | Échap ou clic extérieur | fermé | panneau masqué | `aria-expanded="false"`, focus rendu au bouton |
| formulaire prêt | envoi invalide | erreur | messages sous les champs | `aria-invalid`, focus 1er champ en erreur |
| formulaire prêt | envoi valide | envoi en cours | bouton désactivé, indicateur | `aria-busy`, annonce `aria-live` |

Couvrir aussi les états : vide, chargement, erreur réseau, hors ligne, contenu très long, sans JavaScript.

## 3. Rafraîchissements admis

Une mise à jour de V est légitime seulement si :

1. l'utilisateur vient d'agir ;
2. M a changé ailleurs (autre composant, autre onglet via `BroadcastChannel`/`storage`, réponse serveur) ;
3. la navigation (URL, historique) a changé.

Interdit : re-rendre au `focus` ou `visibilitychange` sans changement de M ; ne mettre à jour qu'une des surfaces qui affichent la même donnée (compteur panier en en-tête resté faux) ; restaurer un état stocké qui contredit M ; `prompt()`/`alert()` bloquants.

## 4. Mise en œuvre

- Une fonction `render(state)` par composant, appelée après chaque mutation ; jamais de modification DOM éparpillée.
- Délégation d'événements sur le conteneur, initialisation une seule fois (`data-ready`).
- L'état d'ouverture vit dans l'attribut (`aria-expanded`, `hidden`, `open`) ; le CSS le lit (`[aria-expanded="true"] + .panel`). Pas de classe d'état en double de l'attribut.
- Effets de transition : propriétés, durée et courbe en tokens ; mesurés, pas estimés.

## 5. Preuve

Pour chaque transition prioritaire : capture ou instantané avant/après, et vérification automatisée si le projet a Playwright :

```js
await page.getByRole('button', { name: 'Menu' }).click();
await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
await page.keyboard.press('Escape');
await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();
```

Sans Playwright : passe manuelle de la matrice, au clavier puis à la souris puis au tactile (DevTools mode appareil). Classer chaque écart P0 (état faux ou bloquant), P1 (délai ou glitch sans état final faux), P2 (finition).
