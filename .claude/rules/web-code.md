# Code front (HTML, CSS, JS)

- Statique d'abord. Rendu serveur ou générateur statique pour le contenu ; JavaScript client seulement pour une interaction réelle (îlot, amélioration progressive).
- HTML sémantique avant ARIA : `button` pour une action, `a` pour une navigation, `details` pour un dépliant, `dialog` pour une modale. Le site reste utilisable sans JS pour le contenu et les formulaires.
- Pas de framework, préprocesseur ou bibliothèque sans besoin prouvé. Chaque dépendance ajoutée est justifiée par écrit.
- Interdit à l'exécution : `eval`, `new Function`, `innerHTML` avec une donnée externe non échappée, `document.write`, `window.prompt`/`alert` comme interface.
- Événements : délégation sur un conteneur, initialisation une seule fois (marqueur `data-*`), pas d'écouteur sur une interface masquée. Les identifiants partagés entre HTML, CSS et JS sont stables ; en renommer un oblige à mettre à jour les trois.
- État d'interface : la vue reflète toujours l'état après une action, sans rafraîchissement parasite (skill `web-ui-states`).
- Stockage navigateur : seulement des préférences légères. Ce qui se déduit en CSS ne se stocke pas.
- Navigateurs : tester Chromium, Firefox (Gecko) et Safari (WebKit), mobile compris. Cible : versions courantes, pas d'IE ni Edge legacy. Fonction récente : vérifier sa disponibilité (Baseline) ou prévoir un repli.
- JSON et données : valides, typées si possible (TypeScript, schéma), jamais de secret dedans.
- Liens et chemins : relatifs à la racine du site ou générés par le framework, jamais de chemin absolu de la machine de dev.
