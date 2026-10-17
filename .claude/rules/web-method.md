# Méthode de travail (tout projet web)

Source : logique formelle, conventions clean code et validation de CapsuleOS, généralisées.

## Décider

- Une seule action possible et sans risque : la faire sans demander.
- Action irréversible ou visible de l'extérieur (push, déploiement, envoi, suppression, achat de domaine, DNS) : validation humaine explicite à chaque fois.
- Commit et fusion en local (branche de travail, branche `integration`) : autorisés sans redemander une fois tout vérifié (tests, build, contrôles du skill `web-audit`). Push vers GitHub : seulement par la session superviseur, après vérification locale et accord d'Alexandre (décision du 16/10/2026).
- Avant d'agir sur l'existant : observer (fichiers, rendu, mesures), lister les écarts réels, ne corriger que ceux-là. Ne jamais deviner une mesure qu'on peut relever.
- Une hypothèse est fausse si le contrôle qui la teste échoue. On corrige le code, jamais le contrôle pour qu'il passe.

## Écrire peu, au bon endroit

- Avant d'ajouter un fichier, un module ou une dépendance : un besoin réel l'exige-t-il ? un existant peut-il être étendu ? est-ce de la donnée plutôt que de la logique ? Trois non : ne pas l'ajouter.
- Une source de vérité par information (identité, contenu, prix, FAQ, tokens). Le reste est généré à partir d'elle. Un fichier généré ne se modifie jamais à la main.
- Diff minimal : une intention, une zone, un contrôle vert. Pas de refactor hors demande.
- Commentaires seulement pour un invariant non évident. Pas de commentaire narratif, pas de TODO non classé.
- Pas de nouvelle doc parallèle (roadmap, plan) quand un document existant couvre le sujet.

## Écarts et dette

- Tout écart connu est noté et classé : P0 bloquant (cassé, illégal, inaccessible, faux), P1 visible mais contournable, P2 finition.
- Absence d'une donnée réelle : échec visible ou section masquée, jamais un substitut inventé ni emprunté ailleurs.

## Vérifier

- Pendant le travail : contrôle minimal du périmètre touché. Corriger les erreurs de cette zone, pas toute la dette du dépôt.
- Avant de déclarer terminé ou de livrer : skill `web-audit`. « Ça devrait marcher » ne vaut pas preuve : lancer, observer, mesurer.
- Compte rendu honnête : ce qui est vérifié, ce qui ne l'est pas, ce qui reste rouge.
